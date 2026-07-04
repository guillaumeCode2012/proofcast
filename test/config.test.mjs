import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig, InvalidConfigError, AI_MODES } from "../dist/config.js";
import { CONFIG_FILENAME } from "../dist/onboarding.js";

/**
 * Build an injected reader from a fixed map of `path → contents`. Any path not in
 * the map is treated as a non-existent file (returns null), exactly like the real
 * fs reader mapping ENOENT → null. No disk is ever touched.
 */
function readerFor(contents, { onRead } = {}) {
  return async (path) => {
    if (onRead) onRead(path);
    return path in contents ? contents[path] : null;
  };
}

const ROOT = join(tmpdir(), "proofcast-config-test");
const CONFIG_PATH = join(resolve(ROOT), CONFIG_FILENAME);

test("AI_MODES exposes exactly the two supported modes", () => {
  assert.deepEqual([...AI_MODES], ["API_KEY", "AGENT_SUBSCRIPTION"]);
});

test("valid API_KEY config loads correctly", async () => {
  const readConfigFile = readerFor({
    [CONFIG_PATH]: JSON.stringify({ aiMode: "API_KEY", apiKey: "sk-abc123" }),
  });
  const config = await loadConfig({ projectRoot: ROOT, readConfigFile });
  assert.equal(config.aiMode, "API_KEY");
  assert.equal(config.apiKey, "sk-abc123");
});

test("valid API_KEY config preserves existing onboarding fields", async () => {
  const readConfigFile = readerFor({
    [CONFIG_PATH]: JSON.stringify({
      aiMode: "API_KEY",
      apiKey: "sk-abc123",
      telegramToken: "123:secret",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  });
  const config = await loadConfig({ projectRoot: ROOT, readConfigFile });
  assert.equal(config.telegramToken, "123:secret");
  assert.equal(config.createdAt, "2026-01-01T00:00:00.000Z");
});

test("API_KEY config with no apiKey throws a clear error AT LOAD TIME", async () => {
  const readConfigFile = readerFor({
    [CONFIG_PATH]: JSON.stringify({ aiMode: "API_KEY" }),
  });
  await assert.rejects(
    () => loadConfig({ projectRoot: ROOT, readConfigFile }),
    (err) => {
      assert.ok(err instanceof InvalidConfigError, "is InvalidConfigError");
      assert.match(err.message, /apiKey/);
      assert.match(err.message, /API_KEY/);
      return true;
    },
  );
});

test("API_KEY config with an empty / whitespace apiKey is rejected", async () => {
  for (const apiKey of ["", "   ", "\t\n"]) {
    const readConfigFile = readerFor({
      [CONFIG_PATH]: JSON.stringify({ aiMode: "API_KEY", apiKey }),
    });
    await assert.rejects(
      () => loadConfig({ projectRoot: ROOT, readConfigFile }),
      InvalidConfigError,
      `apiKey=${JSON.stringify(apiKey)} should be rejected`,
    );
  }
});

test("valid AGENT_SUBSCRIPTION config loads WITHOUT an apiKey", async () => {
  const readConfigFile = readerFor({
    [CONFIG_PATH]: JSON.stringify({ aiMode: "AGENT_SUBSCRIPTION" }),
  });
  const config = await loadConfig({ projectRoot: ROOT, readConfigFile });
  assert.equal(config.aiMode, "AGENT_SUBSCRIPTION");
  assert.equal(config.apiKey, undefined, "no apiKey required in subscription mode");
});

test("missing config file throws a clear error, never a raw crash", async () => {
  // The reader returns null for every path (file absent).
  const readConfigFile = async () => null;
  await assert.rejects(
    () => loadConfig({ projectRoot: ROOT, readConfigFile }),
    (err) => {
      assert.ok(err instanceof InvalidConfigError, "is InvalidConfigError");
      assert.match(err.message, new RegExp(CONFIG_FILENAME.replace(".", "\\.")));
      return true;
    },
  );
});

test("unknown aiMode value (e.g. 'FOO') throws a clear error mentioning both modes", async () => {
  const readConfigFile = readerFor({
    [CONFIG_PATH]: JSON.stringify({ aiMode: "FOO" }),
  });
  await assert.rejects(
    () => loadConfig({ projectRoot: ROOT, readConfigFile }),
    (err) => {
      assert.ok(err instanceof InvalidConfigError, "is InvalidConfigError");
      assert.match(err.message, /API_KEY/);
      assert.match(err.message, /AGENT_SUBSCRIPTION/);
      assert.match(err.message, /FOO/, "echoes the offending value");
      return true;
    },
  );
});

test("absent aiMode throws a clear error (no silent default)", async () => {
  const readConfigFile = readerFor({
    [CONFIG_PATH]: JSON.stringify({ apiKey: "sk-abc123" }),
  });
  await assert.rejects(
    () => loadConfig({ projectRoot: ROOT, readConfigFile }),
    (err) => {
      assert.ok(err instanceof InvalidConfigError);
      assert.match(err.message, /undefined/);
      return true;
    },
  );
});

test("invalid JSON throws a clear error, not a bare SyntaxError", async () => {
  const readConfigFile = readerFor({
    [CONFIG_PATH]: "{ this is : not json ",
  });
  await assert.rejects(
    () => loadConfig({ projectRoot: ROOT, readConfigFile }),
    (err) => {
      assert.ok(err instanceof InvalidConfigError, "wrapped as InvalidConfigError");
      assert.match(err.message, /JSON/);
      return true;
    },
  );
});

test("a non-object JSON (array / string / number) is rejected", async () => {
  for (const body of ["[]", '"hello"', "42", "null"]) {
    const readConfigFile = readerFor({ [CONFIG_PATH]: body });
    await assert.rejects(
      () => loadConfig({ projectRoot: ROOT, readConfigFile }),
      InvalidConfigError,
      `body=${body} should be rejected`,
    );
  }
});

test("loadConfig reads exactly the .proofcast-config.json under projectRoot", async () => {
  let seenPath;
  const readConfigFile = readerFor(
    { [CONFIG_PATH]: JSON.stringify({ aiMode: "AGENT_SUBSCRIPTION" }) },
    { onRead: (p) => (seenPath = p) },
  );
  await loadConfig({ projectRoot: ROOT, readConfigFile });
  assert.equal(seenPath, CONFIG_PATH, "resolves <projectRoot>/.proofcast-config.json");
});
