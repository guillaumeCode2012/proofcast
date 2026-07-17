/**
 * ProofCast proof manifest — the on-disk sidecar that binds a proof video to the
 * exact source it proves.
 *
 * Each proof video (`proofcast-proof.mp4` from `run`/`generate`, or
 * `proofcast-demo-proof.mp4` from `demo`) is written next to a JSON sidecar of the
 * same base name (`proofcast-proof.json` / `proofcast-demo-proof.json`) carrying the
 * {@link hashSourceDir} of the code that was PROVEN. At deploy time the gate reads
 * this sidecar, recomputes the hash of the directory being deployed, and ships only
 * when they match — see {@link verifyProofArtifact}.
 *
 * Fail-closed by construction: a missing, corrupt, or hash-less manifest never
 * verifies, so a broken signal defaults to "no deploy", never a silent pass.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { hashSourceDir } from "./source-hash.js";

/** Filename of the proof video written by `run` / `generate` into the target directory. */
export const PROOF_FILENAME = "proofcast-proof.mp4";

/** Filename of the proof video written by `proofcast demo`. */
export const DEMO_PROOF_FILENAME = "proofcast-demo-proof.mp4";

/**
 * Proof videos the deploy gate recognizes, in PRIORITY order: a real `run`/`generate`
 * proof outranks a `demo` trial. Their presence + a matching hash is the gate's signal.
 */
export const SESSION_PROOF_FILENAMES = [PROOF_FILENAME, DEMO_PROOF_FILENAME] as const;

/** Current manifest schema version (bump on a breaking shape change). */
export const PROOF_MANIFEST_VERSION = 1;

/** The JSON sidecar written next to a proof video. */
export interface ProofManifest {
  /** Schema version. */
  version: number;
  /** The proof video this manifest describes (e.g. `proofcast-proof.mp4`). */
  proofFile: string;
  /** Deterministic hash of the code that was proven, or `null` if it could not be computed. */
  sourceHash: string | null;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** Human label of what was proven (optional). */
  feature?: string;
}

/** Data a caller supplies to stamp a manifest; the rest is filled in. */
export interface WriteManifestInput {
  /** Hash of the PROVEN code (from a {@link ProofReport}); `null`/`undefined` if unknown. */
  sourceHash?: string | null;
  /** Human label of what was proven. */
  feature?: string;
  /** Creation time (default: now) — injectable for deterministic tests. */
  createdAt?: string;
}

/** The `.json` sidecar name for a given proof video (`foo.mp4` → `foo.json`). */
export function manifestFilenameFor(proofFilename: string): string {
  return proofFilename.replace(/\.mp4$/i, ".json");
}

/**
 * Write the JSON sidecar for `proofFilename` into `dir`, stamping the proven-code
 * hash. Returns the sidecar's path. The stored hash is the hash of the code that
 * was PROVEN (not necessarily `dir`), which is what lets a `demo` — proving a
 * bundled example — never authorize deploying an unrelated directory.
 */
export async function writeProofManifest(
  dir: string,
  proofFilename: string,
  input: WriteManifestInput = {},
): Promise<string> {
  const manifest: ProofManifest = {
    version: PROOF_MANIFEST_VERSION,
    proofFile: proofFilename,
    sourceHash: input.sourceHash ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.feature ? { feature: input.feature } : {}),
  };
  const path = join(dir, manifestFilenameFor(proofFilename));
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path;
}

/**
 * Read the highest-priority proof manifest present in `dir` (a real `run`/`generate`
 * proof before a `demo`), requiring BOTH the video and its sidecar to exist. Returns
 * `null` when none is present or the sidecar is corrupt (→ fail closed at the gate).
 */
export async function readProofManifest(dir: string): Promise<ProofManifest | null> {
  for (const proofFilename of SESSION_PROOF_FILENAMES) {
    const videoPath = join(dir, proofFilename);
    const manifestPath = join(dir, manifestFilenameFor(proofFilename));
    if (!(await pathExists(videoPath)) || !(await pathExists(manifestPath))) {
      continue;
    }
    try {
      const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Partial<ProofManifest>;
      if (parsed && typeof parsed === "object") {
        return {
          version: typeof parsed.version === "number" ? parsed.version : PROOF_MANIFEST_VERSION,
          proofFile: typeof parsed.proofFile === "string" ? parsed.proofFile : proofFilename,
          sourceHash: typeof parsed.sourceHash === "string" ? parsed.sourceHash : null,
          createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
          ...(typeof parsed.feature === "string" ? { feature: parsed.feature } : {}),
        };
      }
    } catch {
      /* corrupt sidecar → treat as no proof (fail closed) */
    }
  }
  return null;
}

/** Outcome of checking a directory's proof against its current source. */
export type ProofVerification =
  /** A proof exists AND its stored hash matches the directory's current source. */
  | { status: "verified"; sourceHash: string }
  /** No usable proof (missing video/sidecar, or a corrupt sidecar). */
  | { status: "missing" }
  /** A proof exists but the code changed since — or the proof carries no usable hash. */
  | { status: "stale"; provenHash: string | null; currentHash: string };

/**
 * Verify that `dir` holds a proof bound to its CURRENT source. `verified` only when
 * a manifest exists, carries a hash, and that hash equals a fresh hash of `dir`.
 * Everything else is a refusal: `missing` (no proof) or `stale` (changed / unbindable).
 *
 * @param hash injectable hasher (defaults to {@link hashSourceDir}) for tests.
 */
export async function verifyProofArtifact(
  dir: string,
  hash: (dir: string) => Promise<string> = hashSourceDir,
): Promise<ProofVerification> {
  const manifest = await readProofManifest(dir);
  if (!manifest) {
    return { status: "missing" };
  }
  const currentHash = await hash(dir);
  if (manifest.sourceHash && manifest.sourceHash === currentHash) {
    return { status: "verified", sourceHash: currentHash };
  }
  return { status: "stale", provenHash: manifest.sourceHash, currentHash };
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
