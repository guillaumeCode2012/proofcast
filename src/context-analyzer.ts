/**
 * ProofCast brownfield context analyzer.
 *
 * Before ProofCast modifies an EXISTING project (instead of generating one from
 * scratch), it needs to show the model what is already there. {@link analyzeTargetDirectory}
 * walks a target directory, reads the source/config files, and returns a single
 * structured string with a `## Structure` file tree and a `## Code` dump of the
 * relevant file contents — ready to inject into an AI prompt (see src/ai.ts).
 *
 * Two hard constraints shape the design:
 *   - It must never crash on a bad input (missing dir, empty dir, permission
 *     denied): those return an explicit, prefixed error string instead.
 *   - The dumped code is capped at {@link MAX_CONTEXT_CHARS}. Past that, long
 *     FUNCTION bodies are replaced by a `// ... (corps tronqué, N lignes)` marker
 *     while imports/exports/signatures/types/interfaces are always kept, so the
 *     model still sees the shape of every file without blowing the token budget.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";

/** Directories never descended into (build output, VCS, deps, caches). */
export const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
]);

/** Extensions treated as "key" source files whose content is read. */
export const KEY_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

/** Config files (by exact name) whose content is read alongside source. */
export const KEY_FILENAMES = new Set(["package.json", "tsconfig.json"]);

/**
 * Entry-point file names that should stay COMPLETE (untruncated) if at all
 * possible — they anchor the model's understanding of the project.
 */
export const ENTRY_FILENAMES = new Set([
  "page.tsx",
  "page.jsx",
  "page.ts",
  "page.js",
  "index.ts",
  "index.tsx",
  "index.js",
  "index.jsx",
  "main.ts",
  "main.tsx",
  "main.js",
  "main.jsx",
  "app.ts",
  "app.tsx",
  "app.js",
  "app.jsx",
]);

/** Hard cap (chars) on the total file *content* dumped before truncation kicks in. */
export const MAX_CONTEXT_CHARS = 100_000;

/** A function/method body longer than this many interior lines gets truncated. */
export const MIN_BODY_LINES_TO_TRUNCATE = 4;

/**
 * Prefix marking a returned string as an error (rather than a real analysis).
 * Callers can cheaply detect failure with `result.startsWith(ANALYSIS_ERROR_PREFIX)`.
 */
export const ANALYSIS_ERROR_PREFIX = "PROOFCAST_ANALYSIS_ERROR:";

/** Metadata + content for one key file, gathered before the truncation pass. */
interface KeyFileData {
  /** Path relative to the analyzed root, always with `/` separators. */
  path: string;
  /** Full file content (or a short placeholder if it could not be read). */
  full: string;
  /** `full.length`, precomputed for the greedy budget pass. */
  size: number;
  /** True when the file is an entry point (kept complete first). */
  isEntry: boolean;
}

/**
 * Analyze a target directory into a structured, prompt-ready string.
 *
 * Never throws for expected failures — a missing/empty/unreadable directory
 * yields a string starting with {@link ANALYSIS_ERROR_PREFIX}.
 */
export async function analyzeTargetDirectory(dirPath: string): Promise<string> {
  if (typeof dirPath !== "string" || dirPath.trim().length === 0) {
    return `${ANALYSIS_ERROR_PREFIX} chemin de dossier manquant ou vide.`;
  }

  let stats;
  try {
    stats = await stat(dirPath);
  } catch (err) {
    return `${ANALYSIS_ERROR_PREFIX} le dossier "${dirPath}" est introuvable ou inaccessible (${errMessage(err)}).`;
  }
  if (!stats.isDirectory()) {
    return `${ANALYSIS_ERROR_PREFIX} le chemin "${dirPath}" n'est pas un dossier.`;
  }

  // Probe the root readdir up front so an unreadable root surfaces as a clean
  // error; sub-directory read failures are swallowed inside walk() instead.
  try {
    await readdir(dirPath);
  } catch (err) {
    return `${ANALYSIS_ERROR_PREFIX} impossible de lire le dossier "${dirPath}" (${errMessage(err)}).`;
  }

  const files = await walk(dirPath, dirPath);
  if (files.length === 0) {
    return `${ANALYSIS_ERROR_PREFIX} le dossier "${dirPath}" est vide (aucun fichier analysable).`;
  }

  const structure = renderTree(files);

  const keyPaths = files.filter(isKeyFile).sort();
  if (keyPaths.length === 0) {
    return `## Structure\n${structure}\n\n## Code\n(aucun fichier de code ou de configuration analysable trouvé)\n`;
  }

  const keyFiles = await readKeyFiles(dirPath, keyPaths);
  const code = renderCode(keyFiles);

  return `## Structure\n${structure}\n\n## Code\n${code}`;
}

/**
 * Recursively collect file paths (relative to `root`, posix-separated),
 * skipping {@link EXCLUDED_DIRS} and any dot-directory. Unreadable
 * sub-directories are skipped rather than aborting the whole walk.
 */
async function walk(root: string, dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // unreadable sub-directory: skip it, keep going
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isExcludedDir(entry.name)) continue;
      files.push(...(await walk(root, full)));
    } else if (entry.isFile()) {
      files.push(toPosix(relative(root, full)));
    }
  }
  return files;
}

/** A directory is excluded if it is in the deny-list or begins with a dot. */
function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIRS.has(name) || name.startsWith(".");
}

/** True for source files (by extension) and known config files (by name). */
function isKeyFile(relPath: string): boolean {
  const name = basename(relPath);
  return KEY_EXTENSIONS.has(extname(name).toLowerCase()) || KEY_FILENAMES.has(name);
}

/** Read every key file, tolerating per-file read failures with a placeholder. */
async function readKeyFiles(root: string, keyPaths: string[]): Promise<KeyFileData[]> {
  return Promise.all(
    keyPaths.map(async (relPath) => {
      let full: string;
      try {
        full = await readFile(join(root, fromPosix(relPath)), "utf8");
      } catch (err) {
        full = `// ProofCast: fichier illisible (${errMessage(err)})`;
      }
      return {
        path: relPath,
        full,
        size: full.length,
        isEntry: ENTRY_FILENAMES.has(basename(relPath)),
      };
    }),
  );
}

/**
 * Render the `## Code` body. When the total content fits under
 * {@link MAX_CONTEXT_CHARS} every file is emitted verbatim; otherwise entry
 * files and the smallest files keep their full body while the rest have long
 * function bodies collapsed to a marker.
 */
function renderCode(files: KeyFileData[]): string {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const display = new Map<string, string>();

  if (total <= MAX_CONTEXT_CHARS) {
    for (const f of files) display.set(f.path, f.full);
  } else {
    // Greedy budget: entry files first, then smallest first, keep full while the
    // budget lasts; collapse function bodies once it runs out.
    const order = [...files].sort(byPriority);
    let budget = MAX_CONTEXT_CHARS;
    for (const f of order) {
      if (f.size <= budget) {
        display.set(f.path, f.full);
        budget -= f.size;
      } else {
        const collapsed = truncateSource(f.full);
        display.set(f.path, collapsed);
        budget = Math.max(0, budget - collapsed.length);
      }
    }
  }

  // Emit in stable path order regardless of the priority used to allocate budget.
  return files
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => `### ${f.path}\n\`\`\`${fenceLang(f.path)}\n${display.get(f.path) ?? f.full}\n\`\`\``)
    .join("\n\n");
}

/** Entry files first, then by ascending size (small files survive intact). */
function byPriority(a: KeyFileData, b: KeyFileData): number {
  if (a.isEntry !== b.isEntry) return a.isEntry ? -1 : 1;
  return a.size - b.size;
}

/**
 * Collapse long FUNCTION / METHOD / ARROW bodies into a
 * `// ... (corps tronqué, N lignes)` marker while preserving imports, exports,
 * signatures, and whole `type` / `interface` / `enum` / `class` declarations.
 *
 * This is a deliberately simple brace-depth heuristic (not a real parser): it is
 * only used to shrink oversized dumps and never runs when content fits the cap.
 */
export function truncateSource(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const opens = braceDelta(line) > 0;

    if (opens && isTruncatableHeader(line.trim())) {
      // Walk to the matching closing brace using naive brace counting.
      let depth = braceDelta(line);
      let j = i + 1;
      while (j < lines.length && depth > 0) {
        depth += braceDelta(lines[j] ?? "");
        j++;
      }
      const closeIdx = Math.min(j - 1, lines.length - 1);
      const interior = closeIdx - (i + 1); // lines strictly inside the braces

      if (interior > MIN_BODY_LINES_TO_TRUNCATE) {
        const indent = leadingWhitespace(line) + "  ";
        out.push(line); // signature
        out.push(`${indent}// ... (corps tronqué, ${interior} lignes)`);
        out.push(lines[closeIdx] ?? "}"); // closing brace line
        i = closeIdx; // resume after the whole block
        continue;
      }
      // Short body: keep it verbatim.
      for (let k = i; k <= closeIdx; k++) out.push(lines[k] ?? "");
      i = closeIdx;
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}

/** Net `{` minus `}` on a line (naive; ignores strings/comments by design). */
function braceDelta(line: string): number {
  let delta = 0;
  for (const ch of line) {
    if (ch === "{") delta++;
    else if (ch === "}") delta--;
  }
  return delta;
}

/**
 * True when a block-opening line is a function/method/arrow whose body may be
 * collapsed. Excludes imports/exports-of-types and `type`/`interface`/`enum`
 * declarations (kept whole). `class` is intentionally NOT truncatable so we
 * descend into it and collapse its METHOD bodies instead.
 */
function isTruncatableHeader(trimmed: string): boolean {
  if (/^(import\b|export\s+(type|interface|\{|\*)|type\b|interface\b|enum\b|class\b|export\s+class\b|export\s+default\s+class\b)/.test(trimmed)) {
    return false;
  }
  // Control-flow blocks look like `keyword (...) {` and would match the bare-method
  // rule below — exclude them so only real functions/methods get collapsed.
  if (/^(if|for|while|switch|catch|do|else|try|finally|return|with)\b/.test(trimmed)) {
    return false;
  }
  if (/\bfunction\b/.test(trimmed)) return true; // function / async function / export function
  if (/=>/.test(trimmed)) return true; // arrow function assignment
  if (/^(public|private|protected|static|async|get|set|readonly)\s+/.test(trimmed)) return true;
  // Bare method / call-signature: `name(args) ... {`
  if (/^[A-Za-z_$][\w$]*\s*(<[^>]*>)?\s*\([^;]*\)\s*(:\s*[^={]+)?\{/.test(trimmed)) return true;
  return false;
}

/** The leading run of whitespace of a line (for indenting the marker). */
function leadingWhitespace(line: string): string {
  return /^(\s*)/.exec(line)?.[1] ?? "";
}

/**
 * Render an indented file tree from posix relative paths. Directories are shown
 * with a trailing `/`; entries are sorted (directories before files) per level.
 */
function renderTree(paths: string[]): string {
  type Node = Map<string, Node>;
  const root: Node = new Map();

  for (const p of paths) {
    let node = root;
    for (const part of p.split("/")) {
      let child = node.get(part);
      if (!child) {
        child = new Map();
        node.set(part, child);
      }
      node = child;
    }
  }

  const lines: string[] = [];
  const emit = (node: Node, prefix: string): void => {
    const names = [...node.keys()].sort((a, b) => {
      const aDir = (node.get(a)?.size ?? 0) > 0;
      const bDir = (node.get(b)?.size ?? 0) > 0;
      if (aDir !== bDir) return aDir ? -1 : 1; // directories first
      return a.localeCompare(b);
    });
    for (const name of names) {
      const child = node.get(name)!;
      const isDir = child.size > 0;
      lines.push(`${prefix}${name}${isDir ? "/" : ""}`);
      if (isDir) emit(child, `${prefix}  `);
    }
  };
  emit(root, "");
  return lines.join("\n");
}

/** Fenced-block language hint from a file extension. */
function fenceLang(relPath: string): string {
  switch (extname(relPath).toLowerCase()) {
    case ".ts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".js":
      return "js";
    case ".jsx":
      return "jsx";
    case ".json":
      return "json";
    default:
      return "";
  }
}

/** Normalize an OS path to forward slashes for stable, portable output. */
function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** Convert a posix relative path back to the OS separator for filesystem reads. */
function fromPosix(p: string): string {
  return p.split("/").join(sep);
}

/** Best-effort error message extraction. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
