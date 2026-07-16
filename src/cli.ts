#!/usr/bin/env node
/**
 * ProofCast CLI — two commands.
 *
 *   proofcast run [dirPath]
 *     Pure executor. Proves the code already sitting in `dirPath` (via
 *     {@link proveCode}) and prints a machine-readable JSON report on stdout. It
 *     NEVER generates or fixes code — and, because the prover makes no AI/network
 *     call by construction, it does NOT require a provider API key. That is what
 *     powers the keyless 2-minute local trial (`proofcast run ./examples/signup`).
 *
 *   proofcast generate "<description>" [dirPath]
 *     Autonomous pipeline. Delegates to {@link executeAndHeal} (generate → prove →
 *     self-repair, up to 3 attempts) — ProofCast calls its own AI provider directly,
 *     no external agent involved.
 *
 *   proofcast demo [outDir]
 *     Zero-setup trial. Proves a BUNDLED example project (shipped inside the
 *     package) in a real browser and writes a real MP4 — from ANY empty folder, with
 *     no user files, no API key, no Telegram, no Vercel, and no Docker.
 *
 * Flags (all commands): `--share` also writes a self-contained, portable
 * `proof-<id>/` folder (an `index.html` that plays the video + shows the report,
 * openable via file:// or any static host, no CDN); `--open` opens it in the
 * default browser (implies `--share`). On `--share`, stdout gains a `sharePath`.
 *
 * Output contract (so agents can script on it reliably):
 *   - stdout carries EXACTLY ONE line of JSON (a {@link CliOutput}), always valid —
 *     never a raw stack trace, even on an unexpected failure.
 *   - stderr carries human-readable messages for usage/config errors only.
 *   - the process exit code is 0 on success and non-zero on any failure.
 */

import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadConfig as defaultLoadConfig, type ProofCastConfig } from "./config.js";
import { proveCode as defaultProveCode, type ProofError, type ProofReport } from "./prover.js";
import { executeAndHeal as defaultExecuteAndHeal, type HealResult } from "./orchestrator.js";
import { isDockerAvailable } from "./sandbox.js";
import {
  openInBrowser as defaultOpenInBrowser,
  writeShareableProof as defaultWriteShareableProof,
  type ShareableProofInput,
  type ShareableProofResult,
} from "./share.js";

/** Default repair-attempt budget for `generate` (README documents "up to 3"). */
export const DEFAULT_MAX_RETRIES = 3;

/** Filename of the proof video written into the target directory on success. */
export const PROOF_FILENAME = "proofcast-proof.mp4";

/** Filename of the proof video written by `proofcast demo`. */
export const DEMO_PROOF_FILENAME = "proofcast-demo-proof.mp4";

/**
 * The single JSON object printed on stdout by every command. A superset of the
 * public {@link ProofReport} fields: `errors` carries typed prove failures (run),
 * `error` carries a usage/config/generate-level message, `attempts` is present for
 * `generate`, and `proofPath` points at the video written on success.
 */
export interface CliOutput {
  success: boolean;
  proofPath?: string;
  /** Path to the self-contained, shareable `index.html` (only when `--share`). */
  sharePath?: string;
  errors?: ProofError[];
  error?: string;
  attempts?: number;
  durationMs: number;
}

/** Injectable side-effects. Defaults are the real implementations; tests pass fakes. */
export interface CliDependencies {
  loadConfig: (options?: { projectRoot?: string }) => Promise<ProofCastConfig>;
  proveCode: (dirPath: string) => Promise<ProofReport>;
  /** Prove the bundled demo project. Defaults to LOCAL execution — no Docker, so the demo is truly zero-setup. */
  proveDemo: (dirPath: string) => Promise<ProofReport>;
  executeAndHeal: (description: string, dirPath: string, maxRetries: number) => Promise<HealResult>;
  writeProof: (proofPath: string, video: Buffer) => Promise<void>;
  /** Build the self-contained shareable proof folder (`--share`). */
  writeShare: (input: ShareableProofInput) => Promise<ShareableProofResult>;
  /** Open a path in the default browser (`--open`); best-effort, cross-platform. */
  openPath: (target: string) => Promise<void>;
  /** Environment the provider layer resolves its API key from (default `process.env`). */
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  now: () => number;
}

/** Fill in the real implementations for any dependency the caller did not override. */
function withDefaults(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    loadConfig: overrides.loadConfig ?? defaultLoadConfig,
    proveCode:
      overrides.proveCode ??
      ((dirPath) => defaultProveCode(dirPath, { execution: isDockerAvailable() ? "docker" : "local" })),
    // Force LOCAL: the demo must run from any empty folder without Docker. The
    // bundled example is our own trusted, zero-dependency code, so running it on
    // the host is safe.
    proveDemo: overrides.proveDemo ?? ((dirPath) => defaultProveCode(dirPath, { execution: "local" })),
    executeAndHeal:
      overrides.executeAndHeal ??
      ((description, dirPath, maxRetries) =>
        defaultExecuteAndHeal(description, dirPath, maxRetries, {
          execution: isDockerAvailable() ? "docker" : "local",
        })),
    writeProof: overrides.writeProof ?? (async (proofPath, video) => void (await writeFile(proofPath, video))),
    writeShare: overrides.writeShare ?? ((input) => defaultWriteShareableProof(input)),
    openPath: overrides.openPath ?? (async (target) => void defaultOpenInBrowser(target)),
    env: overrides.env ?? process.env,
    stdout: overrides.stdout ?? ((line) => void process.stdout.write(`${line}\n`)),
    stderr: overrides.stderr ?? ((line) => void process.stderr.write(`${line}\n`)),
    now: overrides.now ?? (() => Date.now()),
  };
}

/** Flags common to every command, split out from the positional arguments. */
interface CliFlags {
  /** `--share`: also emit a self-contained, shareable `proof-<id>/` folder. */
  share: boolean;
  /** `--open`: open the shareable page in the default browser (implies `--share`). */
  open: boolean;
}

/** Split `--share` / `--open` out of `argv`, leaving the positional arguments untouched. */
function parseCliArgs(argv: string[]): { positionals: string[]; flags: CliFlags } {
  const positionals: string[] = [];
  let share = false;
  let open = false;
  for (const arg of argv) {
    if (arg === "--share") share = true;
    else if (arg === "--open") open = true;
    else positionals.push(arg);
  }
  // You cannot open a page that was never produced — `--open` implies `--share`.
  if (open) share = true;
  return { positionals, flags: { share, open } };
}

/** Metadata for a shareable proof folder, once a run has passed. */
interface ShareContext {
  outDir: string;
  video: Buffer | undefined;
  feature: string;
  durationMs: number;
  attempts?: number;
}

/**
 * On `--share`, write the self-contained proof folder next to the proof and, on
 * `--open`, open it in the browser (best-effort). Returns the `index.html` path
 * for the JSON `sharePath` field, or `undefined` when sharing is off / there is no
 * video. Never throws through: a share/open hiccup must not fail a passing proof.
 */
async function buildShareFolder(
  deps: CliDependencies,
  flags: CliFlags,
  ctx: ShareContext,
): Promise<string | undefined> {
  if (!flags.share || !ctx.video || ctx.video.length === 0) {
    return undefined;
  }
  try {
    const result = await deps.writeShare({
      feature: ctx.feature,
      status: "passed",
      durationMs: ctx.durationMs,
      attempts: ctx.attempts,
      video: ctx.video,
      outDir: ctx.outDir,
    });
    if (flags.open) {
      await deps.openPath(result.indexPath).catch(() => {
        /* opening is a convenience — never fail the command over it */
      });
    }
    return result.indexPath;
  } catch (err) {
    deps.stderr(`ProofCast : preuve partageable non générée (${messageOf(err)}).`);
    return undefined;
  }
}

/**
 * `proofcast run [dirPath]` — prove existing code, print JSON, return an exit code.
 *
 * `run` is a PURE prover: it boots + drives + reports, and (unlike `generate`)
 * makes no AI/network call. So a missing or invalid `.proofcast-config.json` is
 * NOT fatal here — proving existing code needs no provider key. We still attempt
 * to load the config and, if it is broken, surface a non-fatal note on stderr so
 * a genuinely misconfigured install is still visible; stdout stays a single JSON
 * line either way. This is what lets the keyless local trial
 * (`proofcast run ./examples/signup`) run with zero setup.
 */
export async function proofcastRun(
  args: string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const deps = withDefaults(overrides);
  const { positionals, flags } = parseCliArgs(args);
  const dirPath = resolve(positionals[0] ?? process.cwd());

  // Advisory only: a broken config never blocks a pure prove.
  try {
    await deps.loadConfig();
  } catch (err) {
    deps.stderr(
      `ProofCast : pas de configuration IA valide (${messageOf(err)}). ` +
        `« run » prouve du code existant sans IA — on continue.`,
    );
  }

  let report: ProofReport;
  try {
    report = await deps.proveCode(dirPath);
  } catch (err) {
    // proveCode is designed to return (not throw) for prove failures; a throw here
    // is unexpected — surface it as structured JSON, never a raw stack on stdout.
    return usageFailure(deps, `Échec inattendu du prover : ${messageOf(err)}`);
  }

  if (report.success) {
    const proofPath = await writeProofIfAny(deps, dirPath, report.video);
    const sharePath = await buildShareFolder(deps, flags, {
      outDir: dirPath,
      video: report.video,
      feature: `Project: ${basename(dirPath)}`,
      durationMs: report.durationMs,
    });
    emit(deps, { success: true, proofPath, sharePath, durationMs: report.durationMs });
    return 0;
  }
  emit(deps, { success: false, errors: report.errors, durationMs: report.durationMs });
  return 1;
}

/**
 * `proofcast generate "<description>" [dirPath]` — autonomous generate+heal.
 */
export async function proofcastGenerate(
  args: string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const deps = withDefaults(overrides);
  const { positionals, flags } = parseCliArgs(args);

  const description = positionals[0];
  if (typeof description !== "string" || description.trim().length === 0) {
    return usageFailure(deps, 'Usage : proofcast generate "<description>" [dirPath] [--share] [--open]');
  }
  const dirPath = resolve(positionals[1] ?? process.cwd());

  let config: ProofCastConfig;
  try {
    config = await deps.loadConfig();
  } catch (err) {
    return usageFailure(deps, `Configuration invalide : ${messageOf(err)}`);
  }

  // Make the configured key reach the provider layer, so an agent that only wrote
  // `apiKey` into .proofcast-config.json (as the README says) can run `generate`
  // without also exporting ANTHROPIC_API_KEY.
  applyApiKeyFromConfig(config, deps.env);

  const start = deps.now();
  let result: HealResult;
  try {
    result = await deps.executeAndHeal(description, dirPath, DEFAULT_MAX_RETRIES);
  } catch (err) {
    deps.stderr(`Échec inattendu : ${messageOf(err)}`);
    emit(deps, { success: false, error: messageOf(err), attempts: 0, durationMs: deps.now() - start });
    return 1;
  }
  const durationMs = deps.now() - start;

  if (result.success) {
    const proofPath = await writeProofIfAny(deps, dirPath, result.video);
    const sharePath = await buildShareFolder(deps, flags, {
      outDir: dirPath,
      video: result.video,
      feature: description,
      durationMs,
      attempts: result.attempts,
    });
    emit(deps, { success: true, proofPath, sharePath, attempts: result.attempts, durationMs });
    return 0;
  }
  emit(deps, { success: false, error: result.lastError, attempts: result.attempts, durationMs });
  return 1;
}

/**
 * `proofcast demo [outDir]` — zero-setup trial.
 *
 * Proves the example bundled inside the package (see {@link bundledExampleDir}),
 * so it depends on NO files in the user's folder. The example is copied into a
 * throwaway temp directory (proving runs `npm install` and writes artifacts, which
 * must never touch the installed package or the user's cwd), proven LOCALLY (no
 * Docker) in a real browser, and the resulting MP4 is written into `outDir`
 * (default: the current directory). The temp copy is always cleaned up.
 */
export async function proofcastDemo(
  args: string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const deps = withDefaults(overrides);
  const { positionals, flags } = parseCliArgs(args);
  const outDir = resolve(positionals[0] ?? process.cwd());
  const start = deps.now();

  const exampleDir = bundledExampleDir();
  if (!(await pathExists(exampleDir))) {
    return usageFailure(
      deps,
      `Exemple bundlé introuvable (${exampleDir}). Réinstalle proofcast — le paquet doit embarquer examples/.`,
    );
  }

  let workDir: string | undefined;
  try {
    workDir = await mkdtemp(join(tmpdir(), "proofcast-demo-"));
    // Copy only the source: never drag along a node_modules / lockfile / a past
    // proof that may sit in the example dir during local development. The filter
    // tests each entry's path RELATIVE to the example root — crucial because the
    // installed package lives UNDER node_modules/, so matching the absolute path
    // would wrongly exclude the entire example (and copy nothing).
    await cp(exampleDir, workDir, {
      recursive: true,
      filter: (src) => {
        const rel = relative(exampleDir, src);
        return !/(?:^|[\\/])node_modules(?:[\\/]|$)|\.mp4$|package-lock\.json$/.test(rel);
      },
    });

    let report: ProofReport;
    try {
      report = await deps.proveDemo(workDir);
    } catch (err) {
      return usageFailure(deps, `Échec inattendu de la démo : ${messageOf(err)}`);
    }

    if (report.success && report.video && report.video.length > 0) {
      await mkdir(outDir, { recursive: true });
      const proofPath = join(outDir, DEMO_PROOF_FILENAME);
      await deps.writeProof(proofPath, report.video);
      const sharePath = await buildShareFolder(deps, flags, {
        outDir,
        video: report.video,
        feature: "ProofCast demo — signup example",
        durationMs: deps.now() - start,
      });
      emit(deps, { success: true, proofPath, sharePath, durationMs: deps.now() - start });
      return 0;
    }
    emit(deps, { success: false, errors: report.errors, durationMs: deps.now() - start });
    return 1;
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {
        /* best-effort cleanup of the throwaway copy */
      });
    }
  }
}

/** Route `argv` to a subcommand and return its exit code. */
export async function runCli(argv: string[], overrides: Partial<CliDependencies> = {}): Promise<number> {
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "run":
      return proofcastRun(rest, overrides);
    case "generate":
      return proofcastGenerate(rest, overrides);
    case "demo":
      return proofcastDemo(rest, overrides);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      withDefaults(overrides).stdout(JSON.stringify(usageOutput()));
      return 0;
    default: {
      const deps = withDefaults(overrides);
      deps.stderr(`Commande inconnue : ${subcommand}. Utilise 'run', 'generate' ou 'demo'.`);
      emit(deps, { success: false, error: `Unknown command: ${subcommand}`, durationMs: 0 });
      return 1;
    }
  }
}

/** Entry point used by the binary: run the CLI and reflect the exit code on the process. */
export async function main(argv: string[]): Promise<void> {
  process.exitCode = await runCli(argv);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Print one JSON line (the machine contract) on stdout. */
function emit(deps: CliDependencies, output: CliOutput): void {
  deps.stdout(JSON.stringify(output));
}

/** Report a usage/config error: human line on stderr + structured JSON on stdout, exit 1. */
function usageFailure(deps: CliDependencies, message: string): number {
  deps.stderr(message);
  emit(deps, { success: false, error: message, durationMs: 0 });
  return 1;
}

/** Write the proof video into the target dir (skipped when there is none), returning its path. */
async function writeProofIfAny(
  deps: CliDependencies,
  dirPath: string,
  video: Buffer | undefined,
): Promise<string | undefined> {
  if (!video || video.length === 0) {
    return undefined;
  }
  const proofPath = join(resolve(dirPath), PROOF_FILENAME);
  await deps.writeProof(proofPath, video);
  return proofPath;
}

/** A minimal machine-readable "help" payload (keeps stdout JSON-only). */
function usageOutput(): CliOutput & { commands: string[] } {
  return {
    success: true,
    durationMs: 0,
    commands: [
      "proofcast run [dirPath] [--share] [--open]",
      'proofcast generate "<description>" [dirPath] [--share] [--open]',
      "proofcast demo [outDir] [--share] [--open]",
    ],
  };
}

/**
 * Absolute path to the example bundled in the package. From the compiled binary
 * (`dist/cli.js`) the example ships one level up at `examples/signup` (see the
 * package.json "files" allowlist), so this resolves correctly both from a clone
 * and from an installed package.
 */
function bundledExampleDir(): string {
  return fileURLToPath(new URL("../examples/signup", import.meta.url));
}

/** True when a path exists (never throws). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Message of an unknown error value. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Expose the config's API key to the provider layer by routing it to the right
 * env var — Anthropic keys are shaped `sk-ant-...`, everything else is assumed to
 * be an OpenAI-compatible key. This is a FALLBACK only: an explicit
 * `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` already in the environment always wins.
 * ProofCast still reads the MODEL from `ANTHROPIC_MODEL` / `OPENAI_MODEL` — it
 * never pre-selects one.
 */
export function applyApiKeyFromConfig(
  config: ProofCastConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!config.apiKey) return;
  const envVar = config.apiKey.startsWith("sk-ant-") ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  if (!env[envVar]?.trim()) {
    env[envVar] = config.apiKey;
  }
}

// Run only when invoked directly as a binary (never on a library import / test).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2));
}
