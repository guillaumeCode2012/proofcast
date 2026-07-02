import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  LIVE_FILENAME,
  getSessionContext,
  logLiveContext,
  readMemory,
  readRecentMemory,
  redactSecrets,
  resetLiveContext,
  writeMemory,
} from "../dist/memory.js";

const FAKE_TELEGRAM_TOKEN = `123456789:${"A".repeat(35)}`;
const FAKE_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("redactSecrets masks tokens/keys but keeps normal text", () => {
  assert.equal(redactSecrets(FAKE_TELEGRAM_TOKEN), "***");
  assert.equal(redactSecrets(`token is ${FAKE_TELEGRAM_TOKEN} now`), "token is *** now");
  assert.equal(redactSecrets(FAKE_API_KEY), "***");
  assert.equal(redactSecrets("recorded 14 bytes for the landing page"), "recorded 14 bytes for the landing page");
});

test("logLiveContext creates, appends, and redacts; getSessionContext reads it back", () => {
  const cwd = tempDir("proofcast-live-");
  try {
    logLiveContext("demo", "requested: a landing page", { cwd });
    logLiveContext("secret", `token=${FAKE_TELEGRAM_TOKEN}`, { cwd });

    const file = join(cwd, LIVE_FILENAME);
    assert.ok(existsSync(file));

    const content = getSessionContext({ cwd });
    assert.match(content, /live session context/, "has the session header");
    assert.match(content, /requested: a landing page/);
    assert.ok(!content.includes(FAKE_TELEGRAM_TOKEN), "secret must be redacted in the live file");
    assert.match(content, /token=\*\*\*/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resetLiveContext wipes previous content down to the header", () => {
  const cwd = tempDir("proofcast-live-reset-");
  try {
    logLiveContext("demo", "first entry", { cwd });
    assert.match(getSessionContext({ cwd }), /first entry/);

    resetLiveContext({ cwd });
    const content = getSessionContext({ cwd });
    assert.match(content, /live session context/);
    assert.ok(!content.includes("first entry"), "previous entries are gone after reset");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writeMemory / readMemory persist redacted entries under ~/.proofcast/memory", () => {
  const home = tempDir("proofcast-home-");
  const cwd = tempDir("proofcast-proj-");
  try {
    writeMemory(`deploy failed with ${FAKE_TELEGRAM_TOKEN}`, { cwd, homeDir: home });
    writeMemory("video recorded 20000 bytes", { cwd, homeDir: home });

    const content = readMemory({ cwd, homeDir: home });
    assert.match(content, /deploy failed/);
    assert.ok(!content.includes(FAKE_TELEGRAM_TOKEN), "secret redacted in memory");
    assert.equal(readRecentMemory(1, { cwd, homeDir: home }).includes("video recorded"), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writeMemory truncates to the last N entries", () => {
  const home = tempDir("proofcast-home-trunc-");
  const cwd = tempDir("proofcast-proj-trunc-");
  try {
    for (let i = 1; i <= 5; i++) {
      writeMemory(`entry number ${i}`, { cwd, homeDir: home, maxLines: 3 });
    }
    const lines = readMemory({ cwd, homeDir: home })
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 3, "keeps only the last 3 entries");
    assert.ok(lines.join("\n").includes("entry number 5"));
    assert.ok(!lines.join("\n").includes("entry number 1"), "oldest entries are dropped");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("memory is scoped per project (two CWDs → two separate files)", () => {
  const home = tempDir("proofcast-home-scope-");
  const projA = tempDir("proofcast-projA-");
  const projB = tempDir("proofcast-projB-");
  try {
    writeMemory("belongs to project A", { cwd: projA, homeDir: home });
    writeMemory("belongs to project B", { cwd: projB, homeDir: home });

    const a = readMemory({ cwd: projA, homeDir: home });
    const b = readMemory({ cwd: projB, homeDir: home });

    assert.match(a, /project A/);
    assert.ok(!a.includes("project B"), "project A memory must not contain project B's history");
    assert.match(b, /project B/);
    assert.ok(!b.includes("project A"), "project B memory must not contain project A's history");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(projA, { recursive: true, force: true });
    rmSync(projB, { recursive: true, force: true });
  }
});
