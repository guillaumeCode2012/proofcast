import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { hashSourceDir, safeHashSourceDir, isExcludedDir, isExcludedFile } from "../dist/source-hash.js";

/** Make a throwaway temp directory. */
function tempDir() {
  return mkdtemp(join(tmpdir(), "proofcast-hash-"));
}

/** Write `content` to `rel` under `dir`, creating parent folders. */
async function write(dir, rel, content) {
  const abs = join(dir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

test("hashSourceDir is deterministic for identical trees and sensitive to content", async () => {
  const dir = await tempDir();
  try {
    await write(dir, "src/index.js", "console.log(1)\n");
    await write(dir, "src/util/helper.js", "export const x = 1\n");
    await write(dir, "package.json", '{"name":"a"}\n');

    const h1 = await hashSourceDir(dir);
    const h2 = await hashSourceDir(dir);
    assert.equal(h1, h2, "hashing the same tree twice yields the same hash");
    assert.match(h1, /^[0-9a-f]{64}$/, "a hex SHA-256");

    await write(dir, "src/index.js", "console.log(2)\n"); // change one byte of source
    const h3 = await hashSourceDir(dir);
    assert.notEqual(h3, h1, "a source change changes the hash");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hashSourceDir IGNORES node_modules and dist (build output / deps never count as source)", async () => {
  const dir = await tempDir();
  try {
    await write(dir, "src/app.js", "export default 42\n");
    const before = await hashSourceDir(dir);

    // Add a ton of dependency + build-output noise.
    await write(dir, "node_modules/left-pad/index.js", "module.exports = () => {}\n");
    await write(dir, "node_modules/.bin/whatever", "#!/bin/sh\n");
    await write(dir, "dist/bundle.js", "/* built */\n");
    await write(dir, "dist/nested/chunk.js", "/* built */\n");
    await write(dir, "build/output.txt", "artifact\n");
    await write(dir, "coverage/lcov.info", "TN:\n");
    await write(dir, ".next/cache/x", "cache\n");

    const after = await hashSourceDir(dir);
    assert.equal(after, before, "node_modules / dist / build / coverage / .next do not affect the hash");

    await write(dir, "src/app.js", "export default 43\n"); // but a real source edit does
    const changed = await hashSourceDir(dir);
    assert.notEqual(changed, before, "a genuine source change is still detected");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hashSourceDir IGNORES ProofCast's own proof artifacts (so writing a proof never shifts the hash)", async () => {
  const dir = await tempDir();
  try {
    await write(dir, "index.html", "<h1>hi</h1>\n");
    const before = await hashSourceDir(dir);

    // Everything the prove/deploy pipeline drops next to the code:
    await write(dir, "proofcast-proof.mp4", "MP4BYTES");
    await write(dir, "proofcast-proof.json", '{"version":1}');
    await write(dir, "proofcast-demo-proof.mp4", "MP4BYTES");
    await write(dir, "proofcast-demo-proof.json", '{"version":1}');
    await write(dir, ".proofcast-config.json", '{"apiKey":"secret"}');
    await write(dir, "proof-2026-07-17_10-00-00-abc123/index.html", "<video>");
    await write(dir, "proof-2026-07-17_10-00-00-abc123/proof.mp4", "MP4BYTES");

    const after = await hashSourceDir(dir);
    assert.equal(after, before, "proof videos, sidecars, share folders and the config are excluded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("safeHashSourceDir returns undefined for a missing directory (never throws)", async () => {
  const missing = join(tmpdir(), `proofcast-absent-${Math.random().toString(36).slice(2)}`);
  assert.equal(await safeHashSourceDir(missing), undefined);
});

test("exclusion predicates cover the documented names", () => {
  assert.ok(isExcludedDir("node_modules"));
  assert.ok(isExcludedDir("dist"));
  assert.ok(isExcludedDir("proof-2026-07-17_10-00-00-abc123"), "shareable proof folders");
  assert.ok(!isExcludedDir("src"));
  assert.ok(!isExcludedDir("proof-utils"), "a normal folder that merely starts with 'proof-' is kept");
  assert.ok(isExcludedFile("proofcast-proof.mp4"));
  assert.ok(isExcludedFile("proofcast-demo-proof.json"));
  assert.ok(!isExcludedFile("app.js"));
});
