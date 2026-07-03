/**
 * ProofCast memory & live context.
 *
 * Two stores, both ALWAYS redacted before writing (see {@link redactSecrets}):
 *   - `proofcast-live.md` (in the project) — the agent's real-time reasoning for
 *     the current session. Reset at session start, then appended to. Read it to
 *     understand the state at the moment of a crash.
 *   - Project-scoped memory `~/.proofcast/memory/<hash>.md` — cross-session
 *     learning, keyed by a hash of the project path (two projects never mix),
 *     truncated to the last N entries so it never grows unbounded.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Live reasoning file kept in the project directory. */
export const LIVE_FILENAME = "proofcast-live.md";

/** Default cap on the number of memory entries retained. */
export const DEFAULT_MAX_MEMORY_LINES = 200;

/**
 * Cap on a single memory entry (chars). Entries are injected verbatim into AI
 * system prompts (see src/ai.ts), so an unbounded one — e.g. a huge error
 * message — would inflate the input tokens of every later generation.
 */
export const MAX_MEMORY_ENTRY_CHARS = 400;

export interface LiveOptions {
  /** Project directory holding `proofcast-live.md` (defaults to `process.cwd()`). */
  cwd?: string;
}

export interface MemoryOptions {
  /** Project directory used to scope the memory file (defaults to `process.cwd()`). */
  cwd?: string;
  /** Home directory holding `.proofcast/memory/` (defaults to `os.homedir()`). */
  homeDir?: string;
  /** Max entries retained by {@link writeMemory} (defaults to {@link DEFAULT_MAX_MEMORY_LINES}). */
  maxLines?: number;
}

/**
 * Mask anything that looks like a token / API key with `***`.
 * Must be applied to ANY text before it is written to disk.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return typeof text === "string" ? text : "";
  }
  return (
    text
      // Telegram bot token: <digits>:<35-ish chars>
      .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, "***")
      // Common API-key prefixes (OpenAI sk-/sk-ant-, pk-, rk-, GitHub, Slack, ...)
      .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/gi, "***")
      // Generic long secrets: >=32 chars containing BOTH a letter and a digit
      .replace(/\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}\b/g, "***")
  );
}

// ── Live context (proofcast-live.md) ───────────────────────────────────────

/** Live files already initialized this process (so we reset once per session). */
const initializedLiveFiles = new Set<string>();

function liveFilePath(options: LiveOptions): string {
  return join(resolve(options.cwd ?? process.cwd()), LIVE_FILENAME);
}

/** Reset `proofcast-live.md` for a new session (wipes previous content). */
export function resetLiveContext(options: LiveOptions = {}): void {
  const file = liveFilePath(options);
  writeFileSync(
    file,
    `# ProofCast — live session context\n\n_Session started ${new Date().toISOString()}_\n`,
    "utf8",
  );
  initializedLiveFiles.add(file);
}

/**
 * Append a redacted reasoning entry to `proofcast-live.md`. The file is reset
 * automatically the first time it is written to in this process (session start).
 */
export function logLiveContext(step: string, details: string, options: LiveOptions = {}): void {
  const file = liveFilePath(options);
  if (!initializedLiveFiles.has(file)) {
    resetLiveContext(options);
  }
  const stamp = new Date().toISOString();
  const safeStep = redactSecrets(String(step)).trim();
  const safeDetails = redactSecrets(String(details)).trim();
  appendFileSync(file, `- **${stamp}** — ${safeStep}: ${safeDetails}\n`, "utf8");
}

/** Return the full content of `proofcast-live.md` (empty string if none). */
export function getSessionContext(options: LiveOptions = {}): string {
  const file = liveFilePath(options);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

// ── Project-scoped memory (~/.proofcast/memory/<hash>.md) ──────────────────

function projectHash(projectPath: string): string {
  return createHash("sha256").update(resolve(projectPath)).digest("hex").slice(0, 16);
}

function memoryFilePath(options: MemoryOptions): string {
  const home = options.homeDir ?? homedir();
  const projectPath = resolve(options.cwd ?? process.cwd());
  return join(home, ".proofcast", "memory", `${projectHash(projectPath)}.md`);
}

/** Read the full project memory (empty string if none). */
export function readMemory(options: MemoryOptions = {}): string {
  const file = memoryFilePath(options);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** Read the last `count` non-empty memory lines, joined by newlines. */
export function readRecentMemory(count: number, options: MemoryOptions = {}): string {
  const content = readMemory(options);
  if (content.length === 0) {
    return "";
  }
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.slice(-Math.max(0, count)).join("\n");
}

/**
 * Append a redacted entry to the project-scoped memory, then truncate the file
 * to the last `maxLines` entries so it never grows without bound.
 */
export function writeMemory(entry: string, options: MemoryOptions = {}): void {
  const file = memoryFilePath(options);
  mkdirSync(dirname(file), { recursive: true });

  let safeEntry = redactSecrets(String(entry)).trim().replace(/\r?\n/g, " ");
  if (safeEntry.length > MAX_MEMORY_ENTRY_CHARS) {
    safeEntry = `${safeEntry.slice(0, MAX_MEMORY_ENTRY_CHARS)}… [truncated]`;
  }
  const line = `- [${new Date().toISOString()}] ${safeEntry}`;

  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = existing.split(/\r?\n/).filter((l) => l.trim().length > 0);
  lines.push(line);

  const maxLines = options.maxLines ?? DEFAULT_MAX_MEMORY_LINES;
  const kept = lines.slice(-Math.max(1, maxLines));
  writeFileSync(file, `${kept.join("\n")}\n`, "utf8");
}
