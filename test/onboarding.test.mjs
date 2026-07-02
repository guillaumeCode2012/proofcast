import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CONFIG_FILENAME,
  TELEGRAM_TOKEN_REGEX,
  generateBotFatherLink,
  loadToken,
  maskToken,
  saveToken,
} from "../dist/onboarding.js";

/** A syntactically valid (but fake) Telegram token: "<digits>:<35 chars>". */
const VALID_TOKEN = `123456789:${"A".repeat(35)}`;
const INVALID_TOKEN = "not-a-real-token";
const SECRET_PART = "A".repeat(35);

/** Create an isolated temp project dir so we never touch the real repo. */
function tempProject() {
  return mkdtempSync(join(tmpdir(), "proofcast-onboarding-"));
}

test("generateBotFatherLink builds the exact deep link for TestBot", () => {
  const url = generateBotFatherLink("TestBot");
  assert.equal(url, "https://t.me/BotFather?text=%2Fnewbot%20TestBot");
});

test("generateBotFatherLink rejects an empty / whitespace name", () => {
  assert.throws(() => generateBotFatherLink("   "), /required/i);
  assert.throws(() => generateBotFatherLink(""), /required/i);
});

test("TELEGRAM_TOKEN_REGEX accepts valid and rejects invalid tokens", () => {
  assert.ok(TELEGRAM_TOKEN_REGEX.test(VALID_TOKEN));
  assert.ok(!TELEGRAM_TOKEN_REGEX.test(INVALID_TOKEN));
  assert.ok(!TELEGRAM_TOKEN_REGEX.test(`123:${"A".repeat(34)}`)); // secret too short
});

test("saveToken writes config and round-trips through loadToken", () => {
  const root = tempProject();
  try {
    saveToken(VALID_TOKEN, root);

    const cfgPath = join(root, CONFIG_FILENAME);
    assert.ok(existsSync(cfgPath), "config file should exist");

    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.equal(parsed.telegramToken, VALID_TOKEN);
    assert.equal(typeof parsed.createdAt, "string");

    assert.equal(loadToken(root), VALID_TOKEN);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saveToken creates .gitignore with the config entry when missing", () => {
  const root = tempProject();
  try {
    assert.ok(!existsSync(join(root, ".gitignore")));
    saveToken(VALID_TOKEN, root);

    const lines = readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/);
    assert.ok(lines.includes(CONFIG_FILENAME), ".gitignore must list the config");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saveToken appends to an existing .gitignore without duplicating", () => {
  const root = tempProject();
  try {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    saveToken(VALID_TOKEN, root);
    saveToken(VALID_TOKEN, root); // second call must NOT duplicate the entry

    const lines = readFileSync(join(root, ".gitignore"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    const occurrences = lines.filter((l) => l === CONFIG_FILENAME).length;
    assert.equal(occurrences, 1, "entry must appear exactly once");
    assert.ok(lines.includes("node_modules/"), "existing entries preserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saveToken rejects an invalid token and writes nothing", () => {
  const root = tempProject();
  try {
    assert.throws(
      () => saveToken(INVALID_TOKEN, root),
      /Invalid Telegram bot token/i,
    );
    assert.ok(
      !existsSync(join(root, CONFIG_FILENAME)),
      "no config file on invalid token",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("errors and maskToken never leak the secret part", () => {
  // maskToken hides the 35-char secret but keeps the (non-secret) bot id.
  const masked = maskToken(VALID_TOKEN);
  assert.equal(masked, "123456789:***");
  assert.ok(!masked.includes(SECRET_PART), "secret must not appear in mask");
  assert.equal(maskToken("no-colon-value"), "***");
  assert.equal(maskToken(""), "***");

  // A rejection message must not echo back the raw input token.
  const root = tempProject();
  try {
    saveToken(VALID_TOKEN.slice(0, -1), root); // one char short -> invalid
    assert.fail("expected saveToken to throw");
  } catch (err) {
    assert.ok(
      !err.message.includes(SECRET_PART),
      "error message must not contain the secret",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
