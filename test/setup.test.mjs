import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkReadiness, formatReadiness } from "../dist/setup.js";
import { saveToken } from "../dist/onboarding.js";

const VALID_TOKEN = `123456789:${"A".repeat(35)}`;

function tempProject() {
  return mkdtempSync(join(tmpdir(), "proofcast-setup-"));
}

test("checkReadiness: nothing configured → not ready, with clear next actions", () => {
  const cwd = tempProject();
  try {
    const r = checkReadiness({ cwd, env: {}, vercelInstalled: false });
    assert.equal(r.ready, false);
    assert.equal(r.checks.find((c) => c.key === "ai").ok, false);
    assert.equal(r.checks.find((c) => c.key === "telegram").ok, false);
    assert.ok(r.nextActions.some((a) => /bot name/i.test(a)), "asks for the bot name only");
    assert.ok(
      r.nextActions.some((a) => /ANTHROPIC_API_KEY|OPENAI_API_KEY/.test(a)),
      "names the provider env vars",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checkReadiness: AI (anthropic) + saved token → ready to start the bot", () => {
  const cwd = tempProject();
  try {
    saveToken(VALID_TOKEN, cwd);
    const r = checkReadiness({
      cwd,
      env: { ANTHROPIC_API_KEY: "x", ANTHROPIC_MODEL: "m" },
      vercelInstalled: true,
    });
    assert.equal(r.ready, true);
    assert.ok(r.nextActions.some((a) => /Ready/i.test(a)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checkReadiness: OpenAI env counts, and Vercel is only needed for deploy", () => {
  const cwd = tempProject();
  try {
    saveToken(VALID_TOKEN, cwd);
    const r = checkReadiness({
      cwd,
      env: { OPENAI_API_KEY: "x", OPENAI_MODEL: "gpt" },
      vercelInstalled: false,
    });
    assert.equal(r.checks.find((c) => c.key === "ai").ok, true);
    assert.equal(r.checks.find((c) => c.key === "vercel").ok, false);
    assert.equal(r.ready, true, "vercel missing does not block starting the bot");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("formatReadiness renders checks and next actions", () => {
  const cwd = tempProject();
  try {
    const text = formatReadiness(checkReadiness({ cwd, env: {}, vercelInstalled: false }));
    assert.match(text, /readiness/i);
    assert.match(text, /✗ ai/);
    assert.match(text, /Next actions/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
