import test from "node:test";
import assert from "node:assert/strict";

import {
  proofcastRun,
  proofcastGenerate,
  runCli,
  applyApiKeyFromConfig,
  PROOF_FILENAME,
} from "../dist/cli.js";

/**
 * Build a capturing harness: records stdout/stderr lines, tracks whether the AI
 * pipeline was ever invoked, and captures any written proof. Nothing touches the
 * real filesystem, Docker, Playwright, or the network.
 */
function harness(overrides = {}) {
  const out = [];
  const err = [];
  const calls = { proveCode: 0, executeAndHeal: [], writeProof: [], loadConfig: 0 };

  const deps = {
    loadConfig: async () => {
      calls.loadConfig++;
      return overrides.config ?? { apiKey: "sk-live" };
    },
    proveCode: async (dirPath) => {
      calls.proveCode++;
      calls.lastProveDir = dirPath;
      return overrides.report ?? { success: true, video: Buffer.from("MP4-PROOF"), durationMs: 7 };
    },
    executeAndHeal: async (description, dirPath, maxRetries) => {
      calls.executeAndHeal.push({ description, dirPath, maxRetries });
      return overrides.heal ?? { success: true, video: Buffer.from("MP4-HEAL"), attempts: 2 };
    },
    writeProof: async (proofPath, video) => {
      calls.writeProof.push({ proofPath, video });
    },
    // An ISOLATED env so tests never mutate the real process.env.
    env: overrides.env ?? {},
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    now: () => 1000,
  };

  // Let a test force loadConfig to throw.
  if (overrides.loadConfig) deps.loadConfig = overrides.loadConfig;

  return { deps, out, err, calls };
}

/** Parse the single JSON line the CLI is contracted to print on stdout. */
function stdoutJson(out) {
  assert.equal(out.length, 1, "exactly one line printed on stdout");
  return JSON.parse(out[0]); // throws if not valid JSON — that is part of the contract
}

// ── proofcast run ────────────────────────────────────────────────────────────

test("run: proves, prints JSON, exit 0", async () => {
  const h = harness({ config: { apiKey: "sk-live" } });
  const code = await proofcastRun(["/target"], h.deps);

  assert.equal(code, 0, "success exit code");
  assert.equal(h.calls.executeAndHeal.length, 0, "run never generates, it only proves");
  assert.equal(h.calls.proveCode, 1, "the project was proven exactly once");

  const json = stdoutJson(h.out);
  assert.equal(json.success, true);
  assert.equal(json.durationMs, 7, "carries the prove duration");
  assert.ok(json.proofPath.endsWith(PROOF_FILENAME), "reports where the proof video was written");
  assert.equal(h.calls.writeProof.length, 1, "the proof video was written to disk");
  assert.equal(h.calls.writeProof[0].video.toString(), "MP4-PROOF");
});

test("run: a failed proof yields exit 1 and the typed errors on stdout (no AI call)", async () => {
  const h = harness({
    config: { apiKey: "sk-live" },
    report: {
      success: false,
      errors: [{ type: "BUILD_FAILED", message: "tsc error", details: "src/x.ts: error TS2322" }],
      durationMs: 4,
    },
  });
  const code = await proofcastRun(["/target"], h.deps);

  assert.equal(code, 1, "failure exit code");
  assert.equal(h.calls.executeAndHeal.length, 0, "still no AI call on a failed proof");
  const json = stdoutJson(h.out);
  assert.equal(json.success, false);
  assert.equal(json.errors[0].type, "BUILD_FAILED");
  assert.equal(json.proofPath, undefined, "no proof path on failure");
  assert.equal(h.calls.writeProof.length, 0, "no video written on failure");
});

test("run: an invalid config fails cleanly (stderr + valid JSON on stdout, exit 1)", async () => {
  const h = harness({
    loadConfig: async () => {
      throw new Error("apiKey manquant");
    },
  });
  const code = await proofcastRun(["/target"], h.deps);

  assert.equal(code, 1);
  assert.equal(h.calls.proveCode, 0, "never proves on a broken config");
  assert.ok(h.err.length >= 1, "human message on stderr");
  const json = stdoutJson(h.out);
  assert.equal(json.success, false);
  assert.match(json.error, /apiKey manquant/, "stdout stays valid JSON — never a raw stack trace");
});

test("run: an unexpected prover throw becomes structured JSON, not a crash", async () => {
  const h = harness({
    config: { apiKey: "sk-live" },
    report: undefined,
  });
  h.deps.proveCode = async () => {
    throw new Error("dockerode exploded");
  };
  const code = await proofcastRun(["/target"], h.deps);

  assert.equal(code, 1);
  const json = stdoutJson(h.out);
  assert.equal(json.success, false);
  assert.match(json.error, /dockerode exploded/);
});

// ── proofcast generate ───────────────────────────────────────────────────────

test("generate: runs the full generate→heal loop and reports attempts + proofPath", async () => {
  const h = harness({
    config: { apiKey: "sk-live" },
    heal: { success: true, video: Buffer.from("MP4-HEAL"), attempts: 2 },
  });
  const code = await proofcastGenerate(["add a reset button", "/target"], h.deps);

  assert.equal(code, 0);
  assert.equal(h.calls.executeAndHeal.length, 1, "the autonomous pipeline ran");
  assert.deepEqual(
    { d: h.calls.executeAndHeal[0].description, r: h.calls.executeAndHeal[0].maxRetries },
    { d: "add a reset button", r: 3 },
    "forwards the description and the 3-attempt budget",
  );

  const json = stdoutJson(h.out);
  assert.equal(json.success, true);
  assert.equal(json.attempts, 2, "reports how many repair attempts happened");
  assert.ok(json.proofPath.endsWith(PROOF_FILENAME));
  assert.equal(h.calls.writeProof.length, 1);
});

test("generate: a configured Anthropic-shaped apiKey is exposed as ANTHROPIC_API_KEY", async () => {
  const h = harness({
    config: { apiKey: "sk-ant-from-config" },
    heal: { success: true, video: Buffer.from("MP4"), attempts: 1 },
  });
  await proofcastGenerate(["add a widget", "/target"], h.deps);
  assert.equal(
    h.deps.env.ANTHROPIC_API_KEY,
    "sk-ant-from-config",
    "an agent that only wrote apiKey to the config can still generate",
  );
});

test("generate: a configured non-Anthropic-shaped apiKey is exposed as OPENAI_API_KEY", async () => {
  const h = harness({
    config: { apiKey: "sk-from-config" },
    heal: { success: true, video: Buffer.from("MP4"), attempts: 1 },
  });
  await proofcastGenerate(["add a widget", "/target"], h.deps);
  assert.equal(h.deps.env.OPENAI_API_KEY, "sk-from-config");
  assert.equal(h.deps.env.ANTHROPIC_API_KEY, undefined);
});

test("applyApiKeyFromConfig: routes by key shape, fills a missing env key, never overwrites an explicit one", () => {
  const anthropic = {};
  applyApiKeyFromConfig({ apiKey: "sk-ant-config" }, anthropic);
  assert.equal(anthropic.ANTHROPIC_API_KEY, "sk-ant-config");
  assert.equal(anthropic.OPENAI_API_KEY, undefined);

  const openai = {};
  applyApiKeyFromConfig({ apiKey: "sk-config" }, openai);
  assert.equal(openai.OPENAI_API_KEY, "sk-config");
  assert.equal(openai.ANTHROPIC_API_KEY, undefined);

  const explicit = { ANTHROPIC_API_KEY: "sk-env-wins" };
  applyApiKeyFromConfig({ apiKey: "sk-ant-config" }, explicit);
  assert.equal(explicit.ANTHROPIC_API_KEY, "sk-env-wins", "an explicit env key always wins");
});

test("generate: a heal failure reports the last error + attempts, exit 1", async () => {
  const h = harness({
    config: { apiKey: "sk-live" },
    heal: { success: false, video: Buffer.alloc(0), attempts: 3, lastError: "[BUILD_FAILED] tsc error TS2322" },
  });
  const code = await proofcastGenerate(["broken feature", "/target"], h.deps);

  assert.equal(code, 1);
  const json = stdoutJson(h.out);
  assert.equal(json.success, false);
  assert.equal(json.attempts, 3);
  assert.match(json.error, /BUILD_FAILED/);
  assert.equal(json.proofPath, undefined, "no proof on failure");
  assert.equal(h.calls.writeProof.length, 0);
});

test("generate: a missing description is a usage error (exit 1), no config load, no heal", async () => {
  const h = harness({ config: { apiKey: "sk-live" } });
  const code = await proofcastGenerate([], h.deps);

  assert.equal(code, 1);
  assert.equal(h.calls.executeAndHeal.length, 0);
  assert.equal(h.calls.loadConfig, 0, "we reject the usage before even reading the config");
  assert.match(stdoutJson(h.out).error, /Usage/);
});

// ── router ───────────────────────────────────────────────────────────────────

test("runCli routes 'run' and 'generate'", async () => {
  const h1 = harness({ config: { apiKey: "sk-live" } });
  assert.equal(await runCli(["run", "/target"], h1.deps), 0);
  assert.equal(h1.calls.proveCode, 1);

  const h2 = harness({ config: { apiKey: "sk-live" } });
  assert.equal(await runCli(["generate", "x", "/target"], h2.deps), 0);
  assert.equal(h2.calls.executeAndHeal.length, 1);
});

test("runCli: unknown command → exit 1 with valid JSON; help → exit 0", async () => {
  const bad = harness();
  assert.equal(await runCli(["frobnicate"], bad.deps), 1);
  assert.equal(stdoutJson(bad.out).success, false);

  const help = harness();
  assert.equal(await runCli([], help.deps), 0);
  assert.equal(stdoutJson(help.out).success, true, "help output is still valid JSON");
});
