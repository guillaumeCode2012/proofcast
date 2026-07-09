import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig, InvalidConfigError } from "../dist/config.js";
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

test("valid config loads correctly", async () => {
  const readConfigFile = readerFor({
    [CONFIG_PATH]: JSON.stringify({ apiKey: "sk-abc123" }),
  });
  const config = await loadConfig({ projectRoot: ROOT, readConfigFile });
  assert.equal(config.apiKey, "sk-abc123");
});

test("valid config preserves existing onboarding fields", async () => {
  const readConfigFile = readerFor({
    [CONFIG_PATH]: JSON.stringify({
      apiKey: "sk-abc123",
      telegramToken: "123:secret",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  });
  const config = await loadConfig({ projectRoot: ROOT, readConfigFile });
  assert.equal(config.telegramToken, "123:secret");
  assert.equal(config.createdAt, "2026-01-01T00:00:00.000Z");
});

test("config with no apiKey throws a clear error AT LOAD TIME", async () => {
  const readConfigFile = readerFor({
    [CONFIG_PATH]: JSON.stringify({}),
  });
  await assert.rejects(
    () => loadConfig({ projectRoot: ROOT, readConfigFile }),
    (err) => {
      assert.ok(err instanceof InvalidConfigError, "is InvalidConfigError");
      assert.match(err.message, /apiKey/);
      return true;
    },
  );
});

test("config with an empty / whitespace apiKey is rejected", async () => {
  for (const apiKey of ["", "   ", "\t\n"]) {
    const readConfigFile = readerFor({
      [CONFIG_PATH]: JSON.stringify({ apiKey }),
    });
    await assert.rejects(
      () => loadConfig({ projectRoot: ROOT, readConfigFile }),
      InvalidConfigError,
      `apiKey=${JSON.stringify(apiKey)} should be rejected`,
    );
  }
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
    { [CONFIG_PATH]: JSON.stringify({ apiKey: "sk-abc123" }) },
    { onRead: (p) => (seenPath = p) },
  );
  await loadConfig({ projectRoot: ROOT, readConfigFile });
  assert.equal(seenPath, CONFIG_PATH, "resolves <projectRoot>/.proofcast-config.json");
});
