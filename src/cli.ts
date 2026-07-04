#!/usr/bin/env node
/**
 * ProofCast CLI — two commands, routed by the install's `aiMode`.
 *
 *   proofcast run [dirPath]
 *     Pure executor, available in BOTH modes. Proves the code already sitting in
 *     `dirPath` (via {@link proveCode}) and prints a machine-readable JSON report
 *     on stdout. It NEVER generates or fixes code. In `AGENT_SUBSCRIPTION` mode
 *     this is the whole contract: the calling agent writes/fixes the code with its
 *     own subscription, runs `proofcast run`, reads the JSON + exit code, and owns
 *     the "fix → re-run" loop.
 *
 *   proofcast generate "<description>" [dirPath]
 *     Autonomous pipeline, `API_KEY` mode ONLY. Delegates to {@link executeAndHeal}
 *     (generate → prove → self-repair, up to 3 attempts). In `AGENT_SUBSCRIPTION`
 *     mode it refuses immediately (clear stderr message, exit 1) — no LLM call, no
 *     fallback.
 *
 * Output contract (so agents can script on it reliably):
 *   - stdout carries EXACTLY ONE line of JSON (a {@link CliOutput}), always valid —
 *     never a raw stack trace, even on an unexpected failure.
 *   - stderr carries human-readable messages for usage/config errors only.
 *   - the process exit code is 0 on success and non-zero on any failure.
 */

import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig as defaultLoadConfig, type ProofCastConfig } from "./config.js";
import { proveCode as defaultProveCode, type ProofError, type ProofReport } from "./prover.js";
import { executeAndHeal as defaultExecuteAndHeal, type HealResult } from "./orchestrator.js";
import { isDockerAvailable } from "./sandbox.js";

/** Default repair-attempt budget for `generate` (README documents "up to 3"). */
export const DEFAULT_MAX_RETRIES = 3;

/** Filename of the proof video written into the target directory on success. */
export const PROOF_FILENAME = "proofcast-proof.mp4";

/**
 * The single JSON object printed on stdout by every command. A superset of the
 * public {@link ProofReport} fields: `errors` carries typed prove failures (run),
 * `error` carries a usage/config/generate-level message, `attempts` is present for
 * `generate`, and `proofPath` points at the video written on success.
 */
export interface CliOutput {
  success: boolean;
  proofPath?: string;
  errors?: ProofError[];
  error?: string;
  attempts?: number;
  durationMs: number;
}

/** Injectable side-effects. Defaults are the real implementations; tests pass fakes. */
export interface CliDependencies {
  loadConfig: (options?: { projectRoot?: string }) => Promise<ProofCastConfig>;
  proveCode: (dirPath: string) => Promise<ProofReport>;
  executeAndHeal: (description: string, dirPath: string, maxRetries: number) => Promise<HealResult>;
  writeProof: (proofPath: string, video: Buffer) => Promise<void>;
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
    executeAndHeal:
      overrides.executeAndHeal ??
      ((description, dirPath, maxRetries) =>
        defaultExecuteAndHeal(description, dirPath, maxRetries, {
          execution: isDockerAvailable() ? "docker" : "local",
        })),
    writeProof: overrides.writeProof ?? (async (proofPath, video) => void (await writeFile(proofPath, video))),
    env: overrides.env ?? process.env,
    stdout: overrides.stdout ?? ((line) => void process.stdout.write(`${line}\n`)),
    stderr: overrides.stderr ?? ((line) => void process.stderr.write(`${line}\n`)),
    now: overrides.now ?? (() => Date.now()),
  };
}

/**
 * `proofcast run [dirPath]` — prove existing code, print JSON, return an exit code.
 * Loads the config purely as a coherence check (it must be a validly configured
 * install); it does NOT branch on `aiMode` — `run` proves the same way in both modes.
 */
export async function proofcastRun(
  args: string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const deps = withDefaults(overrides);
  const dirPath = resolve(args[0] ?? process.cwd());

  // Coherence check: fail early on a missing/invalid install config.
  try {
    await deps.loadConfig();
  } catch (err) {
    return usageFailure(deps, `Configuration invalide : ${messageOf(err)}`);
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
    emit(deps, { success: true, proofPath, durationMs: report.durationMs });
    return 0;
  }
  emit(deps, { success: false, errors: report.errors, durationMs: report.durationMs });
  return 1;
}

/**
 * `proofcast generate "<description>" [dirPath]` — autonomous generate+heal, but
 * ONLY in `API_KEY` mode. In `AGENT_SUBSCRIPTION` mode it refuses (exit 1, stderr).
 */
export async function proofcastGenerate(
  args: string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const deps = withDefaults(overrides);

  const description = args[0];
  if (typeof description !== "string" || description.trim().length === 0) {
    return usageFailure(deps, 'Usage : proofcast generate "<description>" [dirPath]');
  }
  const dirPath = resolve(args[1] ?? process.cwd());

  let config: ProofCastConfig;
  try {
    config = await deps.loadConfig();
  } catch (err) {
    return usageFailure(deps, `Configuration invalide : ${messageOf(err)}`);
  }

  // Hard refusal in subscription mode — no attempt, no fallback, no LLM call.
  if (config.aiMode === "AGENT_SUBSCRIPTION") {
    return usageFailure(
      deps,
      "Erreur : 'generate' nécessite aiMode='API_KEY'. En mode abonnement, écris le code toi-même puis utilise 'proofcast run'.",
    );
  }

  // API_KEY mode: make the configured key reach the provider layer, so an agent
  // that only wrote `apiKey` into .proofcast-config.json (as the README says) can
  // run `generate` without also exporting ANTHROPIC_API_KEY.
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
    emit(deps, { success: true, proofPath, attempts: result.attempts, durationMs });
    return 0;
  }
  emit(deps, { success: false, error: result.lastError, attempts: result.attempts, durationMs });
  return 1;
}

/** Route `argv` to a subcommand and return its exit code. */
export async function runCli(argv: string[], overrides: Partial<CliDependencies> = {}): Promise<number> {
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "run":
      return proofcastRun(rest, overrides);
    case "generate":
      return proofcastGenerate(rest, overrides);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      withDefaults(overrides).stdout(JSON.stringify(usageOutput()));
      return 0;
    default: {
      const deps = withDefaults(overrides);
      deps.stderr(`Commande inconnue : ${subcommand}. Utilise 'run' ou 'generate'.`);
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
    commands: ["proofcast run [dirPath]", 'proofcast generate "<description>" [dirPath]'],
  };
}

/** Message of an unknown error value. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Expose an `API_KEY`-mode config key to the provider layer, which resolves the
 * Anthropic key from the environment. This is a FALLBACK only: an explicit
 * `ANTHROPIC_API_KEY` already in the environment always wins, and a config with no
 * `apiKey` (i.e. `AGENT_SUBSCRIPTION`) is left untouched. ProofCast still reads the
 * MODEL from `ANTHROPIC_MODEL` — it never pre-selects one.
 */
export function applyApiKeyFromConfig(
  config: ProofCastConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (config.apiKey && !env.ANTHROPIC_API_KEY?.trim()) {
    env.ANTHROPIC_API_KEY = config.apiKey;
  }
}

// Run only when invoked directly as a binary (never on a library import / test).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2));
}
