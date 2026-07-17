import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  PROOF_FILENAME,
  DEMO_PROOF_FILENAME,
  manifestFilenameFor,
  writeProofManifest,
  readProofManifest,
  verifyProofArtifact,
} from "../dist/proof-manifest.js";
import { hashSourceDir } from "../dist/source-hash.js";

function tempDir() {
  return mkdtemp(join(tmpdir(), "proofcast-manifest-"));
}
async function write(dir, rel, content) {
  const abs = join(dir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

test("manifestFilenameFor maps a proof video to its JSON sidecar", () => {
  assert.equal(manifestFilenameFor(PROOF_FILENAME), "proofcast-proof.json");
  assert.equal(manifestFilenameFor(DEMO_PROOF_FILENAME), "proofcast-demo-proof.json");
});

test("write/read round-trips the proven-code hash", async () => {
  const dir = await tempDir();
  try {
    await write(dir, PROOF_FILENAME, "MP4"); // the video must exist alongside the sidecar
    await writeProofManifest(dir, PROOF_FILENAME, { sourceHash: "abc123", feature: "Project: demo" });

    const manifest = await readProofManifest(dir);
    assert.equal(manifest.proofFile, PROOF_FILENAME);
    assert.equal(manifest.sourceHash, "abc123");
    assert.equal(manifest.feature, "Project: demo");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("(a) prove then deploy with NO change → verified", async () => {
  const dir = await tempDir();
  try {
    await write(dir, "src/app.js", "export default 1\n");
    // Stamp the manifest with the hash of the proven code (as the prover does).
    const proven = await hashSourceDir(dir);
    await write(dir, PROOF_FILENAME, "MP4");
    await writeProofManifest(dir, PROOF_FILENAME, { sourceHash: proven });

    const v = await verifyProofArtifact(dir);
    assert.equal(v.status, "verified", "unchanged code deploys");
    assert.equal(v.sourceHash, proven);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("(b) prove, then EDIT a source file, then deploy → stale (refused)", async () => {
  const dir = await tempDir();
  try {
    await write(dir, "src/app.js", "export default 1\n");
    const proven = await hashSourceDir(dir);
    await write(dir, PROOF_FILENAME, "MP4");
    await writeProofManifest(dir, PROOF_FILENAME, { sourceHash: proven });

    // The user changes the code AFTER proving.
    await write(dir, "src/app.js", "export default 2\n");

    const v = await verifyProofArtifact(dir);
    assert.equal(v.status, "stale", "a changed codebase is refused");
    assert.equal(v.provenHash, proven);
    assert.notEqual(v.currentHash, proven, "the current source hashes differently");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no manifest (or no video) → missing", async () => {
  const dir = await tempDir();
  try {
    await write(dir, "src/app.js", "export default 1\n");
    // A sidecar with no video should NOT count as a proof.
    await writeProofManifest(dir, PROOF_FILENAME, { sourceHash: await hashSourceDir(dir) });
    // (the video was never written)
    const v = await verifyProofArtifact(dir);
    assert.equal(v.status, "missing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a manifest with a null hash never verifies (fail closed)", async () => {
  const dir = await tempDir();
  try {
    await write(dir, "src/app.js", "export default 1\n");
    await write(dir, PROOF_FILENAME, "MP4");
    await writeProofManifest(dir, PROOF_FILENAME, { sourceHash: null });

    const v = await verifyProofArtifact(dir);
    assert.equal(v.status, "stale", "an unbindable proof is treated as not-current, never a pass");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a real run/generate proof outranks a demo proof in the same folder", async () => {
  const dir = await tempDir();
  try {
    await write(dir, "src/app.js", "export default 1\n");
    await write(dir, PROOF_FILENAME, "MP4");
    await write(dir, DEMO_PROOF_FILENAME, "MP4");
    await writeProofManifest(dir, PROOF_FILENAME, { sourceHash: "RUN" });
    await writeProofManifest(dir, DEMO_PROOF_FILENAME, { sourceHash: "DEMO" });

    const manifest = await readProofManifest(dir);
    assert.equal(manifest.proofFile, PROOF_FILENAME, "the run proof wins");
    assert.equal(manifest.sourceHash, "RUN");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
