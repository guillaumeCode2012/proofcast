import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolve } from "node:path";

import {
  DirectoryNotFoundError,
  FALLBACK_DIRNAME,
  extractFolderName,
  isProcessEntryPoint,
  resolveAnyDirectory,
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

test("resolveAnyDirectory accepts an absolute path OUTSIDE the project (any folder)", async () => {
  const project = mkdtempSync(join(tmpdir(), "proofcast-proj-"));
  const external = mkdtempSync(join(tmpdir(), "proofcast-external-"));
  try {
    const result = await resolveAnyDirectory(external, { cwd: project });
    assert.equal(result, resolve(external), "returns the external directory as-is");
    assert.ok(
      relative(project, result).startsWith(".."),
      "the target is intentionally OUTSIDE the ProofCast project",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("resolveAnyDirectory resolves a relative path against the cwd", async () => {
  const project = mkdtempSync(join(tmpdir(), "proofcast-proj-"));
  mkdirSync(join(project, "app"), { recursive: true });
  try {
    const result = await resolveAnyDirectory("./app", { cwd: project });
    assert.equal(result, resolve(project, "app"));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("resolveAnyDirectory throws DirectoryNotFoundError for a path that doesn't exist", async () => {
  const project = mkdtempSync(join(tmpdir(), "proofcast-proj-"));
  const missing = join(tmpdir(), `proofcast-missing-${Date.now()}`);
  try {
    await assert.rejects(() => resolveAnyDirectory(missing, { cwd: project }), DirectoryNotFoundError);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("resolveAnyDirectory falls back to the safe project search for a bare name", async () => {
  const project = tempTree(["src/example"]);
  try {
    const result = await resolveAnyDirectory("example", { cwd: project });
    assert.equal(relative(project, result), join("src", "example"));
    assert.ok(!relative(project, result).startsWith(".."), "bare names stay inside the project");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("resolveAnyDirectory returns null for an empty hint (greenfield)", async () => {
  assert.equal(await resolveAnyDirectory(""), null);
  assert.equal(await resolveAnyDirectory("   "), null);
});

// ── the binary entry-point guard ────────────────────────────────────────────

/**
 * Regression cover for a bug that made `proofcast` a SILENT NO-OP on every
 * Linux/macOS global install: `npm i -g` exposes the CLI as a symlink in `bin/`,
 * so `process.argv[1]` is the link while `import.meta.url` is the real file Node
 * loaded. Comparing them un-normalised is always false — `main()` never ran, the
 * process printed nothing and exited 0. Windows hid it (npm writes a .cmd shim
 * that names the real path), which is why it survived so long.
 */
test("isProcessEntryPoint matches the module actually being executed", () => {
  const original = process.argv[1];
  const realFile = fileURLToPath(new URL("../dist/path-resolver.js", import.meta.url));
  try {
    process.argv[1] = realFile;
    assert.equal(isProcessEntryPoint(pathToFileURL(realFile).href), true);

    process.argv[1] = join(realFile, "..", "..", "dist", "path-resolver.js");
    assert.equal(isProcessEntryPoint(pathToFileURL(realFile).href), true, "a non-normalised path still matches");

    process.argv[1] = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    assert.equal(isProcessEntryPoint(pathToFileURL(realFile).href), false, "a different module is not the entry point");
  } finally {
    process.argv[1] = original;
  }
});

test("isProcessEntryPoint resolves a bin SYMLINK to its target", (t) => {
  const original = process.argv[1];
  const realFile = fileURLToPath(new URL("../dist/path-resolver.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "proofcast-bin-"));
  const link = join(dir, "proofcast");
  try {
    try {
      symlinkSync(realFile, link, "file");
    } catch {
      // Creating symlinks needs Developer Mode / elevation on Windows.
      t.skip("symlinks unavailable on this machine");
      return;
    }
    process.argv[1] = link;
    assert.equal(
      isProcessEntryPoint(pathToFileURL(realFile).href),
      true,
      "invoked through a bin symlink, the CLI must still recognise itself and run main()",
    );
  } finally {
    process.argv[1] = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isProcessEntryPoint is false when there is no entry path at all", () => {
  const original = process.argv[1];
  try {
    process.argv[1] = undefined;
    assert.equal(isProcessEntryPoint("file:///anything.js"), false);
    process.argv[1] = join(tmpdir(), "proofcast-does-not-exist", "nope.js");
    assert.equal(isProcessEntryPoint("file:///anything.js"), false, "a missing argv[1] must not throw");
  } finally {
    process.argv[1] = original;
  }
});
