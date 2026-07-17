/**
 * ProofCast source hashing — bind a proof to the exact code it proves.
 *
 * {@link hashSourceDir} produces a deterministic, cross-platform SHA-256 over the
 * SOURCE files of a directory. A proof stamps this hash (see src/proof-manifest.ts);
 * the deploy gate recomputes it and refuses to ship if the code changed since the
 * proof — closing the "prove, then quietly edit, then deploy the unproven version"
 * hole.
 *
 * Determinism guarantees:
 *   - Files are visited recursively and hashed in a STABLE order (sorted by their
 *     POSIX-normalized relative path, so Windows `\` and POSIX `/` agree).
 *   - Each file contributes `relPath \0 sha256(content) \n`; per-file hashing keeps
 *     memory flat and makes the boundary between path and bytes unambiguous.
 *   - Build output, dependencies, VCS metadata and ProofCast's OWN artifacts are
 *     excluded — so `npm install`, a build, or writing the proof/manifest next to
 *     the code never changes the hash (prove-time and deploy-time hashes match).
 *   - Symlinks are skipped (cycle-safe and non-deterministic across machines).
 *
 * Note on line endings: content bytes are hashed verbatim (no CRLF/LF folding), so
 * a genuine byte change is always detected. A proof and its deploy happen on the
 * same machine in the same session, so this needs no cross-OS byte-normalization.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Directory names never counted as source (build output, deps, VCS, caches, proofs). */
export const HASH_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  ".turbo",
  ".cache",
  ".vercel",
]);

/** File names never counted as source: ProofCast's own artifacts + editor/OS junk. */
export const HASH_EXCLUDED_FILES: ReadonlySet<string> = new Set([
  "proofcast-proof.mp4",
  "proofcast-demo-proof.mp4",
  "proofcast-proof.json",
  "proofcast-demo-proof.json",
  ".proofcast-config.json",
  ".DS_Store",
]);

/**
 * Shareable-proof folders (`proof-<ISO-ish-id>`) written by `--share`. Excluded so
 * that adding `--share` — which creates such a folder next to the code — never
 * shifts the hash between prove time and deploy time.
 */
const SHARE_DIR_RE = /^proof-\d{4}-\d{2}-\d{2}_/;

/** True when a directory (by name) must not be descended into for hashing. */
export function isExcludedDir(name: string): boolean {
  return HASH_EXCLUDED_DIRS.has(name) || SHARE_DIR_RE.test(name);
}

/** True when a file (by name) must not contribute to the source hash. */
export function isExcludedFile(name: string): boolean {
  return HASH_EXCLUDED_FILES.has(name);
}

/** One source file, keyed by its POSIX-normalized path relative to the hash root. */
interface SourceFile {
  rel: string;
  abs: string;
}

/**
 * Compute a deterministic SHA-256 (hex) over the source files under `dir`.
 * Excludes {@link HASH_EXCLUDED_DIRS}, {@link HASH_EXCLUDED_FILES}, shareable-proof
 * folders and symlinks. A directory with no source files hashes to a fixed value
 * (the SHA-256 of the empty stream), so two source-empty trees compare equal.
 *
 * @throws if `dir` cannot be read (e.g. it does not exist). Callers that must never
 *         throw should use {@link safeHashSourceDir}.
 */
export async function hashSourceDir(dir: string): Promise<string> {
  const files: SourceFile[] = [];
  await collectSourceFiles(dir, dir, files);
  // Stable, locale-independent ordering by the normalized relative path.
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const digest = createHash("sha256");
  for (const file of files) {
    const content = await readFile(file.abs);
    const fileHash = createHash("sha256").update(content).digest("hex");
    digest.update(file.rel);
    digest.update("\0");
    digest.update(fileHash);
    digest.update("\n");
  }
  return digest.digest("hex");
}

/** Like {@link hashSourceDir} but returns `undefined` instead of throwing (e.g. missing dir). */
export async function safeHashSourceDir(dir: string): Promise<string | undefined> {
  try {
    return await hashSourceDir(dir);
  } catch {
    return undefined;
  }
}

/** Recursively gather eligible source files under `dir`, keyed relative to `root`. */
async function collectSourceFiles(root: string, dir: string, out: SourceFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Skip symlinks entirely: they invite cycles and are not deterministic.
    if (entry.isSymbolicLink()) {
      continue;
    }
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isExcludedDir(entry.name)) {
        continue;
      }
      await collectSourceFiles(root, abs, out);
    } else if (entry.isFile()) {
      if (isExcludedFile(entry.name)) {
        continue;
      }
      out.push({ rel: relative(root, abs).split(sep).join("/"), abs });
    }
  }
}
