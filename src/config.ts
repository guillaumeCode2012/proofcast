/**
 * ProofCast dual-mode configuration.
 *
 * ProofCast runs in one of two mutually exclusive modes, chosen ONCE at install
 * time by the user's agent (Claude Code, Codex, …) and written to
 * `.proofcast-config.json`. ProofCast itself never asks the human — it only reads
 * what the agent persisted:
 *
 *   - `API_KEY`            — ProofCast is fully autonomous: it generates, tests and
 *                           self-heals code by calling the AI SDK with `apiKey`.
 *   - `AGENT_SUBSCRIPTION` — ProofCast makes NO LLM call at all. The agent writes
 *                           the code with its own subscription; ProofCast only
 *                           proves it (see src/prover.ts, src/cli.ts).
 *
 * {@link loadConfig} is deliberately strict: a missing file, invalid JSON, an
 * unknown/absent `aiMode`, or an `API_KEY` mode with no key all fail LOUDLY with
 * an actionable message. There is never a silent fallback to a default mode —
 * picking the wrong mode would either leak an unintended AI call or wrongly refuse
 * one, so the caller must fix the config rather than guess.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Single source of truth for the filename: onboarding already owns/gitignores it.
// Imported (not re-exported) so index.ts's `export *` keeps exactly one binding.
import { CONFIG_FILENAME } from "./onboarding.js";

/** The two AI backends ProofCast can be wired to. Never inferred — always explicit. */
export type AiMode = "API_KEY" | "AGENT_SUBSCRIPTION";

/** All valid {@link AiMode} values, for validation and error messages. */
export const AI_MODES: readonly AiMode[] = ["API_KEY", "AGENT_SUBSCRIPTION"];

/**
 * Full shape persisted to `.proofcast-config.json`. `aiMode` is required; `apiKey`
 * is required only in `API_KEY` mode (enforced by {@link loadConfig}). The
 * remaining fields are written by onboarding (src/onboarding.ts) and preserved
 * here so the config file has a single, complete type.
 */
export interface ProofCastConfig {
  /** Which AI backend ProofCast uses. Must be present and one of {@link AI_MODES}. */
  aiMode: AiMode;
  /** Anthropic (or compatible) API key — present ONLY when `aiMode === "API_KEY"`. */
  apiKey?: string;
  /** Existing onboarding field: the Telegram bot token. */
  telegramToken?: string;
  /** Existing onboarding field: ISO timestamp of when the config was created. */
  createdAt?: string;
}

/**
 * Thrown when `.proofcast-config.json` is missing, malformed, or internally
 * inconsistent (bad/absent `aiMode`, or `API_KEY` mode with no key). The message
 * always says what to fix — this error is meant to be shown to the agent verbatim.
 */
export class InvalidConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConfigError";
  }
}

/** Reader for the config file: its text, or `null` when the file does not exist. */
export type ConfigFileReader = (path: string) => Promise<string | null>;

export interface LoadConfigOptions {
  /** Directory that holds `.proofcast-config.json` (default: `process.cwd()`). */
  projectRoot?: string;
  /**
   * Injected file reader. Defaults to the real fs (ENOENT → `null`). Tests pass a
   * fake so no real file is ever read or written.
   */
  readConfigFile?: ConfigFileReader;
}

/**
 * Load and validate the dual-mode config from `.proofcast-config.json`.
 *
 * @throws {InvalidConfigError} if the file is absent, not valid JSON, has an
 *   absent/unknown `aiMode`, or is in `API_KEY` mode with a missing/empty key.
 *   Never returns a partially-valid or defaulted config.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<ProofCastConfig> {
  const root = resolve(options.projectRoot ?? process.cwd());
  const configPath = join(root, CONFIG_FILENAME);
  const read = options.readConfigFile ?? defaultReadConfigFile;

  const raw = await read(configPath);
  if (raw === null) {
    throw new InvalidConfigError(
      `Config introuvable : ${CONFIG_FILENAME} n'existe pas dans ${root}. ` +
        `Crée-le avec un champ aiMode ('API_KEY' ou 'AGENT_SUBSCRIPTION').`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InvalidConfigError(
      `Config invalide : ${CONFIG_FILENAME} n'est pas un JSON valide ` +
        `(${err instanceof Error ? err.message : String(err)}). Corrige le fichier.`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidConfigError(
      `Config invalide : ${CONFIG_FILENAME} doit contenir un objet JSON. Vérifie le fichier.`,
    );
  }

  const config = parsed as Record<string, unknown>;
  const aiMode = config.aiMode;
  if (aiMode !== "API_KEY" && aiMode !== "AGENT_SUBSCRIPTION") {
    throw new InvalidConfigError(
      `Config invalide : aiMode doit être 'API_KEY' ou 'AGENT_SUBSCRIPTION', ` +
        `trouvé: ${describe(aiMode)}. Vérifie ${CONFIG_FILENAME}.`,
    );
  }

  if (aiMode === "API_KEY") {
    const apiKey = config.apiKey;
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      throw new InvalidConfigError(
        `Config invalide : aiMode='API_KEY' exige un champ apiKey non vide, ` +
          `trouvé: ${describe(apiKey)}. Ajoute ta clé API dans ${CONFIG_FILENAME} ` +
          `(ou passe en aiMode='AGENT_SUBSCRIPTION').`,
      );
    }
  }

  // Rebuild a clean, typed object rather than trusting the raw parse verbatim.
  const result: ProofCastConfig = { aiMode };
  if (typeof config.apiKey === "string") result.apiKey = config.apiKey;
  if (typeof config.telegramToken === "string") result.telegramToken = config.telegramToken;
  if (typeof config.createdAt === "string") result.createdAt = config.createdAt;
  return result;
}

/** Default reader: real fs, mapping a missing file to `null` (any other error rethrows). */
async function defaultReadConfigFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Human-readable rendering of an unexpected value for an error message. */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return String(value);
}
