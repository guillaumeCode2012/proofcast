import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import {
  FALLBACK_DIRNAME,
  extractFolderName,
  resolveTargetDirectory,
  sanitizeFolderName,
} from "../dist/path-resolver.js";

/** Create an isolated temp project with the given relative subdirectories. */
function tempTree(subdirs) {
  const root = mkdtempSync(join(tmpdir(), "proofcast-nav-"));
  for (const sub of subdirs) {
    mkdirSync(join(root, sub), { recursive: true });
  }
  return root;
}

test("extractFolderName pulls the folder name from a natural-language hint", () => {
  assert.equal(extractFolderName("Travaille dans le dossier example"), "example");
  assert.equal(extractFolderName("travaille sur example"), "example");
  assert.equal(extractFolderName("folder my-app"), "my-app");
  assert.equal(extractFolderName("directory: services"), "services");
  assert.equal(extractFolderName("example"), "example");
});

test("sanitizeFolderName neutralizes traversal and absolute paths", () => {
  assert.equal(sanitizeFolderName("../../etc"), "etc");
  assert.equal(sanitizeFolderName("/etc/passwd"), "passwd");
  assert.equal(sanitizeFolderName("..\\..\\windows"), "windows");
  assert.equal(sanitizeFolderName("example"), "example");
  assert.equal(sanitizeFolderName(".."), "");
  assert.equal(sanitizeFolderName(""), "");
});

test("resolveTargetDirectory returns the shallowest match (alphabetical tie-break)", async () => {
  const root = tempTree(["src/example", "test/example"]);
  try {
    const result = await resolveTargetDirectory("Travaille dans le dossier example", { cwd: root });
    assert.equal(relative(root, result), join("src", "example"));
    assert.ok(!relative(root, result).startsWith(".."), "must stay inside the project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveTargetDirectory prefers the minimum depth", async () => {
  const root = tempTree(["example", "src/example"]);
  try {
    const result = await resolveTargetDirectory("example", { cwd: root });
    assert.equal(relative(root, result), "example", "depth-1 wins over depth-2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveTargetDirectory matches partially, case-insensitively", async () => {
  const root = tempTree(["src/ExampleApp"]);
  try {
    const result = await resolveTargetDirectory("dossier exampleapp", { cwd: root });
    assert.equal(relative(root, result), join("src", "ExampleApp"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveTargetDirectory excludes node_modules and dot-directories", async () => {
  const root = tempTree(["node_modules/example", ".hidden/example"]);
  try {
    const result = await resolveTargetDirectory("example", { cwd: root });
    // The only "example" folders are excluded → fall back, never match them.
    assert.equal(relative(root, result), FALLBACK_DIRNAME);
    assert.ok(existsSync(result));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveTargetDirectory creates ./proofcast-workspace when nothing matches", async () => {
  const root = tempTree([]);
  try {
    const result = await resolveTargetDirectory("no-such-folder-xyz", { cwd: root });
    assert.equal(relative(root, result), FALLBACK_DIRNAME);
    assert.ok(existsSync(result), "fallback directory must be created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveTargetDirectory neutralizes a malicious hint and never escapes the CWD", async () => {
  const root = tempTree(["src"]);
  try {
    const result = await resolveTargetDirectory("../../etc", { cwd: root });
    const rel = relative(root, result);
    assert.ok(!rel.startsWith(".."), `must not escape CWD, got ${rel}`);
    // "../../etc" → neutralized to "etc"; no such dir → fallback inside the project.
    assert.equal(rel, FALLBACK_DIRNAME);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
