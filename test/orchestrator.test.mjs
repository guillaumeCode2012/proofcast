import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { HealTimeoutError, executeAndHeal, writeFileChanges } from "../dist/orchestrator.js";

/** A change set the fake AI returns — one modify, no redundant create. */
const OK_CHANGES = JSON.stringify([
  { path: "index.js", action: "modify", content: "console.log('ok');\n" },
]);

/** A failed ProofReport carrying a single typed error. */
function failure(type, message) {
  return { success: false, errors: [{ type, message, details: message }], durationMs: 1 };
}

/** A successful ProofReport carrying a proof video. */
function success(videoText) {
  return { success: true, video: Buffer.from(videoText), durationMs: 1 };
}

const FAKE_DIR = join(tmpdir(), "proofcast-heal-fake-project");

test("executeAndHeal heals on the 2nd attempt and runs the loop exactly twice", async () => {
  const calls = { generate: [], prove: 0, memory: [] };

  const deps = {
    generateFeature: async (description, options) => {
      calls.generate.push({ description, options });
      return OK_CHANGES;
    },
    writeFiles: async (_dir, changes) => changes.map((c) => c.path),
    // Attempt 1: a runtime TypeError; attempt 2: clean + a video.
    proveCode: async () => {
      const i = calls.prove++;
      return i === 0
        ? failure("RUNTIME_ERROR", "pageerror: TypeError x is not a function")
        : success("MP4-PROOF");
    },
    writeMemory: (entry) => calls.memory.push(entry),
  };

  const result = await executeAndHeal("add a reset button", FAKE_DIR, 3, { deps, memory: false });

  assert.equal(result.success, true, "eventually succeeds");
  assert.equal(result.attempts, 2, "exactly two attempts");
  assert.equal(result.video.toString(), "MP4-PROOF", "returns the proof video");

  assert.equal(calls.generate.length, 2, "generated exactly twice");
  assert.equal(calls.prove, 2, "proved exactly twice");
  assert.equal(calls.memory.length, 1, "one failed attempt recorded to memory");
  assert.match(calls.memory[0], /TypeError/, "memory captured the precise error");

  // The 2nd generation is a brownfield fix carrying the previous error.
  const healPrompt = calls.generate[1].description;
  assert.match(healPrompt, /Le code précédent a généré cette erreur/);
  assert.match(healPrompt, /TypeError x is not a function/);
  assert.equal(calls.generate[1].options.targetDir, FAKE_DIR, "brownfield targetDir forwarded");
});

test("executeAndHeal gives up after maxRetries and records every failed attempt", async () => {
  const calls = { generate: 0, prove: 0, memory: 0 };

  const deps = {
    generateFeature: async () => {
      calls.generate++;
      return OK_CHANGES;
    },
    writeFiles: async (_dir, changes) => changes.map((c) => c.path),
    proveCode: async () => {
      calls.prove++;
      return failure("CONSOLE_ERROR", "console.error: still broken");
    },
    writeMemory: () => calls.memory++,
  };

  const result = await executeAndHeal("build something", FAKE_DIR, 3, { deps, memory: false });

  assert.equal(result.success, false, "reports failure");
  assert.equal(result.attempts, 3, "used the full budget");
  assert.match(result.lastError, /still broken/, "carries the last error");
  assert.equal(result.video.length, 0, "no video on failure");

  assert.equal(calls.generate, 3, "generated three times");
  assert.equal(calls.prove, 3, "proved three times");
  assert.equal(calls.memory, 3, "each failed attempt recorded");
});

test("executeAndHeal treats a generation/parse failure as a healable attempt (no prove)", async () => {
  const calls = { generate: 0, prove: 0, memory: 0 };

  const deps = {
    generateFeature: async () => {
      calls.generate++;
      return calls.generate === 1 ? "this is not JSON at all" : OK_CHANGES;
    },
    writeFiles: async (_dir, changes) => changes.map((c) => c.path),
    proveCode: async () => {
      calls.prove++;
      return success("OK");
    },
    writeMemory: () => calls.memory++,
  };

  const result = await executeAndHeal("make a page", FAKE_DIR, 3, { deps, memory: false });

  assert.equal(result.success, true);
  assert.equal(result.attempts, 2, "the bad JSON attempt was retried");
  assert.equal(calls.generate, 2);
  assert.equal(calls.prove, 1, "the project is only proven after a successful generation");
  assert.equal(calls.memory, 1, "the parse failure was recorded");
});

test("executeAndHeal enforces a global timeout even if the prover hangs", async () => {
  const deps = {
    generateFeature: async () => OK_CHANGES,
    writeFiles: async (_dir, changes) => changes.map((c) => c.path),
    // Never resolves — the global timeout must rescue the run.
    proveCode: () => new Promise(() => {}),
    writeMemory: () => {},
  };

  const result = await executeAndHeal("hang please", FAKE_DIR, 3, {
    deps,
    memory: false,
    timeoutMs: 200,
  });

  assert.equal(result.success, false);
  assert.match(result.lastError, /timeout/i, "reports the timeout");
  assert.equal(result.attempts, 1, "timed out during the first attempt");
});

test("HealTimeoutError message names the elapsed budget", () => {
  assert.match(new HealTimeoutError(1234).message, /1234 ms/);
});

test("executeAndHeal validates its inputs", async () => {
  await assert.rejects(() => executeAndHeal("", FAKE_DIR), TypeError);
  await assert.rejects(() => executeAndHeal("desc", ""), TypeError);
});

test("writeFileChanges writes inside the project and refuses path traversal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proofcast-write-"));
  try {
    const written = await writeFileChanges(dir, [
      { path: "src/app.js", action: "create", content: "export const x = 1;\n" },
    ]);
    assert.deepEqual(written, ["src/app.js"]);
    assert.equal(readFileSync(join(dir, "src", "app.js"), "utf8"), "export const x = 1;\n");

    await assert.rejects(
      () => writeFileChanges(dir, [{ path: "../escape.js", action: "create", content: "nope" }]),
      /outside the target directory/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
