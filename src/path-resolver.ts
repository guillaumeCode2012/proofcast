/**
 * ProofCast smart navigation.
 *
 * Turns a natural-language hint ("travaille dans le dossier example") into an
 * absolute directory path — WITHOUT ever leaving the project root.
 *
 * Security (OBLIGATOIRE):
 *   - Suspicious hints (`../`, absolute paths) are NEUTRALIZED before searching:
 *     only a single safe final segment is kept — never resolved as-is.
 *   - The scan only walks inside the CWD, and the returned path is double-checked
 *     to stay within it (`path.relative(cwd, result)` never starts with `..`).
 *
 * Performance: heavy/noisy directories are excluded from the recursive scan.
 */

import { mkdirSync, readdirSync } from "node:fs";
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
