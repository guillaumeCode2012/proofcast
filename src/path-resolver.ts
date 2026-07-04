/**
 * ProofCast smart navigation.
 *
 * Two resolvers, two trust models:
 *   - {@link resolveTargetDirectory} — a natural-language hint → a directory that
 *     is GUARANTEED to stay inside the project root (the safe, name-based search).
 *   - {@link resolveAnyDirectory} — lets the user target an EXISTING project
 *     ANYWHERE on the machine via an explicit path (absolute / `~` / relative),
 *     falling back to the project-scoped search for a bare name. Used by the bot
 *     so a "Démo" can run against a real codebase outside ProofCast.
 *
 * Performance: heavy/noisy directories are excluded from the recursive scan.
 */

import { mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Thrown if a resolved path would escape the project root (defense-in-depth). */
export class PathEscapeError extends Error {
  constructor(candidate: string) {
    super(`Refusing a path that escapes the project root: ${JSON.stringify(candidate)}`);
    this.name = "PathEscapeError";
  }
}

/** Directories never scanned (slow / noisy / irrelevant). Dot-dirs are also excluded. */
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next"]);

/** Directory created (and returned) when no matching folder is found. */
export const FALLBACK_DIRNAME = "proofcast-workspace";

function isExcluded(name: string): boolean {
  return name.startsWith(".") || EXCLUDED_DIRS.has(name);
}

/**
 * Extract the target folder name from a hint. Recognizes
 * "dossier/folder/répertoire/directory/dir X"; otherwise uses the last word.
 */
export function extractFolderName(hint: string): string {
  const trimmed = (hint ?? "").trim();
  const keyed = trimmed.match(
    /(?:dossier|folder|r[ée]pertoire|directory|dir)\s+["'`]?([^\s"'`]+)/i,
  );
  const keyword = keyed?.[1];
  if (keyword) {
    return keyword;
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  return parts.at(-1) ?? "";
}

/**
 * Neutralize path traversal and absolute paths: split on separators, drop `.`
 * and `..`, and keep only the final safe segment. "../../etc" → "etc".
 */
export function sanitizeFolderName(name: string): string {
  const segments = (name ?? "")
    .replace(/[\\/]+/g, " ")
    .split(/\s+/)
    .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..");
  return segments.at(-1) ?? "";
}

/**
 * Breadth-first scan from `root` for a directory whose name matches `term`
 * (case-insensitive). BFS returns the SHALLOWEST match; at a given depth an
 * exact name beats a partial one. Returns `null` when nothing matches.
 */
function findMatchingDir(root: string, term: string): string | null {
  const termLower = term.toLowerCase();
  if (termLower.length === 0) {
    return null;
  }
  let level: string[] = [root];
  while (level.length > 0) {
    const nextLevel: string[] = [];
    let partial: string | null = null;
    for (const dir of [...level].sort()) {
      let names: string[];
      try {
        names = readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !isExcluded(entry.name))
          .map((entry) => entry.name)
          .sort();
      } catch {
        continue; // unreadable directory — skip
      }
      for (const name of names) {
        const full = join(dir, name);
        const lower = name.toLowerCase();
        if (lower === termLower) {
          return full; // shallowest exact match
        }
        if (partial === null && lower.includes(termLower)) {
          partial = full; // remember first partial at this depth
        }
        nextLevel.push(full);
      }
    }
    if (partial !== null) {
      return partial; // no exact at this depth → use the partial
    }
    level = nextLevel;
  }
  return null;
}

/**
 * Resolve a natural-language hint to an absolute directory inside the project.
 *
 * @param hint    e.g. "travaille dans le dossier example".
 * @param options `cwd` overrides the project root (defaults to `process.cwd()`).
 * @returns the matched directory, or a freshly-created `./proofcast-workspace`.
 * @throws {PathEscapeError} if the resolved path would leave the project root.
 */
export async function resolveTargetDirectory(
  hint: string,
  options: { cwd?: string } = {},
): Promise<string> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const term = sanitizeFolderName(extractFolderName(hint));

  let candidate = term.length > 0 ? findMatchingDir(cwd, term) : null;

  if (candidate === null) {
    candidate = join(cwd, FALLBACK_DIRNAME);
    mkdirSync(candidate, { recursive: true });
  }

  // Defense-in-depth: never return a path outside the project root.
  const resolved = resolve(candidate);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathEscapeError(candidate);
  }
  return resolved;
}

/** Thrown when an explicitly-specified directory does not exist (or isn't a dir). */
export class DirectoryNotFoundError extends Error {
  constructor(path: string) {
    super(`Directory not found (or not a directory): ${JSON.stringify(path)}`);
    this.name = "DirectoryNotFoundError";
  }
}

/**
 * Resolve a hint to a target directory that may live ANYWHERE on the machine.
 *
 *   - A PATH-LIKE hint (absolute, `~`, `./`, `../`, `/…`, `X:\…`, or anything
 *     containing a separator) is used DIRECTLY — it is intentionally NOT confined
 *     to the project — after verifying it points at an existing directory.
 *   - A bare NAME/phrase falls back to the project-scoped {@link resolveTargetDirectory}
 *     (you cannot sanely search the whole disk by name).
 *
 * Returns `null` for an empty hint so the caller can treat that as "no target"
 * (e.g. greenfield generation).
 *
 * @throws {DirectoryNotFoundError} if a path-like hint doesn't resolve to a directory.
 */
export async function resolveAnyDirectory(
  hint: string,
  options: { cwd?: string } = {},
): Promise<string | null> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const raw = stripQuotes((hint ?? "").trim());
  if (raw.length === 0) {
    return null;
  }

  if (isPathLikeHint(raw)) {
    const expanded = expandHome(raw);
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
    if (isExistingDirectory(abs)) {
      return abs;
    }
    throw new DirectoryNotFoundError(abs);
  }

  // Bare name → safe, project-scoped search (never escapes the project).
  return resolveTargetDirectory(raw, { cwd });
}

/** Strip a single layer of surrounding quotes/backticks. */
export function stripQuotes(value: string): string {
  return value.replace(/^["'`]+/, "").replace(/["'`]+$/, "");
}

/**
 * True when a hint should be treated as an explicit filesystem PATH (absolute,
 * Windows drive, `~`, or containing a separator) rather than a bare name. Callers
 * use this to decide whether a token is a real path target vs. plain prose.
 */
export function isPathLikeHint(value: string): boolean {
  return (
    isAbsolute(value) ||
    /^[a-zA-Z]:[\\/]/.test(value) || // Windows drive (C:\ or C:/)
    value.startsWith("~") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

/** Expand a leading `~` to the user's home directory. */
function expandHome(value: string): string {
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(1));
  }
  return value;
}

/** True if `p` exists and is a directory (never throws). */
function isExistingDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
