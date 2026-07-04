/**
 * ProofCast self-healing orchestrator (`API_KEY` mode).
 *
 * {@link executeAndHeal} is the level-2 agent loop: it generates a feature into
 * an EXISTING project (brownfield, see src/ai.ts + src/context-analyzer.ts), then
 * PROVES it via {@link proveCode} (src/prover.ts) — which boots it in an isolated
 * Docker sandbox, drives it with Playwright, and reports typed errors. If the
 * proof fails, the errors are fed back to the model to fix its own code, up to a
 * bounded number of attempts.
 *
 * This module owns ONLY the generate → prove → repair loop. All of the
 * sandbox/Playwright machinery now lives in the prover, which executeAndHeal
 * merely calls (once per attempt) — the loop no longer duplicates any of it, and
 * the prover tears its own sandbox down in a `finally` so no container leaks.
 *
 * Safety contract (non-negotiable, see the guards below):
 *   - The retry loop is a `for` bounded by `maxRetries` — never `while (true)`.
 *   - A global wall-clock timeout caps the whole run so a hung step can never
 *     block forever; on timeout the run resolves as a failed {@link HealResult}.
 *   - Each proof cleans up its own sandbox (prover `finally`), so aborting the
 *     loop never orphans a container.
 *
 * Every heavy side-effect (AI call, disk writes, the proof itself, memory) is an
 * injectable dependency so the loop logic can be tested without a network, a
 * browser, a container, or a real server.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  generateFeature as defaultGenerateFeature,
  parseBrownfieldResponse,
  type FileChange,
  type GenerateFeatureOptions,
} from "./ai.js";
import { writeMemory as defaultWriteMemory } from "./memory.js";
import { proveCode as defaultProveCode, type ProofError, type ProofReport } from "./prover.js";

/** Default host port the proof's local server binds and Playwright connects to. */
export const DEFAULT_HEAL_PORT = 3000;

/** Default global wall-clock cap for a whole {@link executeAndHeal} run (ms). */
export const DEFAULT_HEAL_TIMEOUT_MS = 5 * 60_000;

/** Final result of a self-heal run. */
export interface HealResult {
  /** The proof video (MP4) on success; an empty buffer on failure. */
  video: Buffer;
  /** True when a healthy run was proven within the attempt budget. */
  success: boolean;
  /** Number of generate → prove attempts actually performed. */
  attempts: number;
  /** The last error observed when `success` is false. */
  lastError?: string;
}

/** Injectable side-effects. Defaults are the real implementations; tests pass fakes. */
export interface HealDependencies {
  /** Generate a brownfield change set (raw model text). */
  generateFeature: (description: string, options: GenerateFeatureOptions) => Promise<string>;
  /** Write a brownfield change set to disk; returns the written relative paths. */
  writeFiles: (dirPath: string, changes: FileChange[]) => Promise<string[]>;
  /** Prove the project (boot + drive + report). One attempt, no internal retry. */
  proveCode: (dirPath: string) => Promise<ProofReport>;
  /** Persist a redacted note (used for each failed attempt). */
  writeMemory: (entry: string) => void;
}

export interface ExecuteAndHealOptions {
  /** Host port for the local server (default {@link DEFAULT_HEAL_PORT}). */
  port?: number;
  /** Global wall-clock cap for the whole run (default {@link DEFAULT_HEAL_TIMEOUT_MS}). */
  timeoutMs?: number;
  /**
   * Where the project runs: `"docker"` (default) in an isolated sandbox, or
   * `"local"` directly on the host (fallback when Docker isn't available).
   * Forwarded to the default {@link proveCode}; ignored if `deps.proveCode` is set.
   */
  execution?: "docker" | "local";
  /** Override any subset of the heavy side-effects (real by default). */
  deps?: Partial<HealDependencies>;
  /** Memory scoping/disabling forwarded to `generateFeature`. */
  memory?: GenerateFeatureOptions["memory"];
}

/** Thrown internally when the global timeout fires; surfaced as a failed {@link HealResult}. */
export class HealTimeoutError extends Error {
  constructor(ms: number) {
    super(`executeAndHeal exceeded its global timeout of ${ms} ms.`);
    this.name = "HealTimeoutError";
  }
}

/**
 * Generate a feature into an existing project and repair it until it proves clean,
 * or until the attempt budget / global timeout is exhausted.
 *
 * @param description  what to build/change (natural language).
 * @param dirPath      the existing project to modify (brownfield).
 * @param maxRetries   max generate → prove attempts (>=1, default 3).
 * @throws {TypeError} for a blank description or dirPath.
 */
export async function executeAndHeal(
  description: string,
  dirPath: string,
  maxRetries = 3,
  options: ExecuteAndHealOptions = {},
): Promise<HealResult> {
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new TypeError("A non-empty feature description is required.");
  }
  if (typeof dirPath !== "string" || dirPath.trim().length === 0) {
    throw new TypeError("A non-empty target directory path is required.");
  }

  const retries = Number.isInteger(maxRetries) && maxRetries > 0 ? maxRetries : 3;
  const port = options.port ?? DEFAULT_HEAL_PORT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEAL_TIMEOUT_MS;
  const execution = options.execution ?? "docker";
  const deps = withDefaultDeps(options.deps, { port, execution });

  let attempts = 0;

  const loop = async (): Promise<HealResult> => {
    let lastError: string | undefined;
    let currentDescription = description;

    for (let attempt = 1; attempt <= retries; attempt++) {
      attempts = attempt;
      let attemptError: string | undefined;

      try {
        const raw = await deps.generateFeature(currentDescription, {
          targetDir: dirPath,
          memory: options.memory,
        });
        const changes = parseBrownfieldResponse(raw);
        await deps.writeFiles(dirPath, changes);

        // Delegate the whole boot/test/report + teardown to the prover.
        const report = await deps.proveCode(dirPath);
        if (report.success) {
          return { video: report.video ?? Buffer.alloc(0), success: true, attempts };
        }
        attemptError = serializeProofErrors(report.errors);
      } catch (err) {
        attemptError = err instanceof Error ? (err.stack ?? err.message) : String(err);
      }

      lastError = attemptError;
      try {
        deps.writeMemory(`ProofCast heal attempt ${attempt}/${retries} failed: ${summarizeError(attemptError)}`);
      } catch {
        /* memory logging is best-effort — it must never break (or hang) the heal loop */
      }
      currentDescription = buildHealingPrompt(description, attemptError ?? "unknown error");
    }

    return { video: Buffer.alloc(0), success: false, attempts, lastError };
  };

  // NB: this timer is intentionally NOT unref'd — it must be able to fire and
  // rescue the run even if the loop is stuck on a promise with no live handle.
  // It is always cleared in the finally below on normal completion.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HealTimeoutError(timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([loop(), deadline]);
  } catch (err) {
    if (err instanceof HealTimeoutError) {
      return { video: Buffer.alloc(0), success: false, attempts, lastError: err.message };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Serialize a proof's typed errors into a single log for the healing prompt / memory. */
function serializeProofErrors(errors: ProofError[] | undefined): string {
  if (!errors || errors.length === 0) {
    return "unknown error";
  }
  return errors
    .map((e) => (e.details ? `[${e.type}] ${e.message}\n${e.details}` : `[${e.type}] ${e.message}`))
    .join("\n");
}

/** Build the explicit "fix your own error" prompt fed back to the model. */
function buildHealingPrompt(originalDescription: string, errorLog: string): string {
  return (
    `Le code précédent a généré cette erreur :\n${errorLog}\n\n` +
    `Corrige uniquement les fichiers concernés, ne recrée rien d'autre. ` +
    `Demande initiale : ${originalDescription}`
  );
}

/** One-line, file-hinted summary of an error for the memory log. */
function summarizeError(error: string | undefined): string {
  if (!error) return "unknown error";
  const firstLine = error.split("\n").find((l) => l.trim().length > 0) ?? error;
  const file = /([\w./-]+\.(?:tsx?|jsx?))(?::\d+)?/.exec(error)?.[1];
  return file ? `${firstLine.trim()} (fichier probable : ${file})` : firstLine.trim();
}

/** Fill in the real implementations for any dependency the caller did not override. */
function withDefaultDeps(
  overrides: Partial<HealDependencies> = {},
  proof: { port: number; execution: "docker" | "local" },
): HealDependencies {
  return {
    generateFeature: overrides.generateFeature ?? defaultGenerateFeature,
    writeFiles: overrides.writeFiles ?? writeFileChanges,
    proveCode:
      overrides.proveCode ?? ((dirPath: string) => defaultProveCode(dirPath, { port: proof.port, execution: proof.execution })),
    writeMemory: overrides.writeMemory ?? ((entry) => defaultWriteMemory(entry)),
  };
}

/**
 * Write a brownfield change set to disk under `dirPath`. Each target is checked
 * to stay inside `dirPath` (defense-in-depth against `../` in a model-supplied
 * path). Returns the written relative (posix) paths.
 */
export async function writeFileChanges(dirPath: string, changes: FileChange[]): Promise<string[]> {
  const root = resolve(dirPath);
  const written: string[] = [];
  for (const change of changes) {
    const target = resolve(root, change.path);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Refusing to write outside the target directory: ${JSON.stringify(change.path)}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, change.content, "utf8");
    written.push(rel.split(sep).join("/"));
  }
  return written;
}
