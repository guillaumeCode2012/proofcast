import test from "node:test";
import assert from "node:assert/strict";

import {
  computeHmac,
  verifyWebhookSignature,
  parseSentryEvent,
  parseGitHubEvent,
  handleWebhook,
  startWebhookServer,
} from "../dist/webhook.js";
import { runIssueToPr, createScheduler, buildFixGoal } from "../dist/daemon.js";

const SECRET = "whsec_test_secret";

// ── signature verification ────────────────────────────────────────────────────

test("verifyWebhookSignature accepts a correct sentry/github signature, rejects the rest", () => {
  const body = '{"hello":"world"}';
  const sig = computeHmac(body, SECRET);

  assert.equal(verifyWebhookSignature(body, sig, SECRET, "sentry"), true);
  assert.equal(verifyWebhookSignature(body, `sha256=${sig}`, SECRET, "github"), true, "github sha256= prefix");

  assert.equal(verifyWebhookSignature(body, sig, "wrong-secret", "sentry"), false);
  assert.equal(verifyWebhookSignature(body, undefined, SECRET, "sentry"), false, "missing signature");
  assert.equal(verifyWebhookSignature(body, "deadbeef", SECRET, "sentry"), false, "wrong length");
  assert.equal(verifyWebhookSignature("tampered", sig, SECRET, "sentry"), false, "body changed");
});

// ── event parsing ──────────────────────────────────────────────────────────────

test("parseSentryEvent normalizes an error alert", () => {
  const ev = parseSentryEvent({
    action: "triggered",
    data: { event: { title: "TypeError: x is undefined", culprit: "app/pay.js", web_url: "https://sentry.io/e/1" } },
  });
  assert.deepEqual(ev, {
    source: "sentry",
    kind: "triggered",
    title: "TypeError: x is undefined",
    detail: "app/pay.js",
    url: "https://sentry.io/e/1",
  });
});

test("parseGitHubEvent normalizes an issue event with its action + event name", () => {
  const ev = parseGitHubEvent(
    { action: "opened", issue: { title: "Login is broken", body: "steps...", html_url: "https://github.com/o/r/issues/3" } },
    "issues",
  );
  assert.equal(ev.source, "github");
  assert.equal(ev.kind, "issues.opened");
  assert.equal(ev.title, "Login is broken");
  assert.equal(ev.url, "https://github.com/o/r/issues/3");
});

test("parsers tolerate missing fields", () => {
  assert.equal(parseSentryEvent({}).title, "Sentry alert");
  assert.equal(parseGitHubEvent({}).title, "GitHub event");
});

// ── handleWebhook ──────────────────────────────────────────────────────────────

function sentryReq(body, { secret = SECRET, method = "POST" } = {}) {
  return { method, body, headers: { "sentry-hook-signature": computeHmac(body, secret) } };
}

test("handleWebhook: 202 + dispatch on a valid signature", async () => {
  const body = JSON.stringify({ action: "triggered", data: { event: { title: "boom" } } });
  const seen = [];
  const res = await handleWebhook(sentryReq(body), {
    secret: SECRET,
    scheme: "sentry",
    onEvent: (e) => seen.push(e),
  });
  assert.equal(res.status, 202);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].title, "boom");
});

test("handleWebhook: rejects a forged signature (401) and NEVER dispatches", async () => {
  const body = JSON.stringify({ data: {} });
  let dispatched = false;
  const res = await handleWebhook(
    { method: "POST", body, headers: { "sentry-hook-signature": "sha256=forged" } },
    { secret: SECRET, scheme: "sentry", onEvent: () => (dispatched = true) },
  );
  assert.equal(res.status, 401);
  assert.equal(dispatched, false, "a forged event never reaches the agent loop");
});

test("handleWebhook: 405 for non-POST, 400 for invalid JSON (valid signature)", async () => {
  const notPost = await handleWebhook(sentryReq("{}", { method: "GET" }), {
    secret: SECRET,
    scheme: "sentry",
    onEvent: () => {},
  });
  assert.equal(notPost.status, 405);

  const badJson = await handleWebhook(sentryReq("not json at all"), {
    secret: SECRET,
    scheme: "sentry",
    onEvent: () => {},
  });
  assert.equal(badJson.status, 400);
});

test("handleWebhook: a throwing dispatcher becomes a 500 (never crashes)", async () => {
  const body = JSON.stringify({ data: {} });
  const res = await handleWebhook(sentryReq(body), {
    secret: SECRET,
    scheme: "sentry",
    onEvent: () => {
      throw new Error("scheduling failed");
    },
  });
  assert.equal(res.status, 500);
});

// ── real HTTP server (hermetic, ephemeral port) ───────────────────────────────

test("startWebhookServer accepts a signed POST and rejects a forged one", async () => {
  const events = [];
  const server = await startWebhookServer({
    secret: SECRET,
    scheme: "sentry",
    onEvent: (e) => events.push(e),
  });
  try {
    const body = JSON.stringify({ action: "triggered", data: { event: { title: "prod is down" } } });

    const okRes = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
      headers: { "sentry-hook-signature": computeHmac(body, SECRET) },
      body,
    });
    assert.equal(okRes.status, 202);
    assert.equal(events.length, 1);
    assert.equal(events[0].title, "prod is down");

    const forged = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
      headers: { "sentry-hook-signature": "nope" },
      body,
    });
    assert.equal(forged.status, 401);
    assert.equal(events.length, 1, "the forged request was not dispatched");
  } finally {
    await server.close();
  }
});

// ── runIssueToPr (the gated reaction) ─────────────────────────────────────────

const EVENT = { source: "sentry", kind: "error", title: "500 on /pay", detail: "app/pay.js", url: "https://s.io/1" };

function issueDeps(overrides = {}) {
  const calls = { branch: 0, agent: 0, prove: 0, commit: 0, pr: [] };
  const deps = {
    createBranch: async () => {
      calls.branch++;
    },
    runAgent: async () => {
      calls.agent++;
      return { success: true, summary: "fixed the null deref", steps: [], stepsUsed: 2 };
    },
    proveCode: async () => {
      calls.prove++;
      return { success: true, video: Buffer.from("MP4"), durationMs: 5 };
    },
    commitAll: async () => {
      calls.commit++;
      return { committed: true };
    },
    openProvenPullRequest: async (input) => {
      calls.pr.push(input);
      return { url: "https://github.com/o/r/pull/1" };
    },
    ...overrides,
  };
  return { deps, calls };
}

const CONFIG = { dirPath: "/repo", planner: { decide: async () => ({ type: "finish", summary: "x" }) }, registry: {} };

test("runIssueToPr: full happy path → branch, fix, prove, commit, gated PR", async () => {
  const { deps, calls } = issueDeps();
  const result = await runIssueToPr(EVENT, CONFIG, deps);

  assert.equal(result.success, true);
  assert.equal(result.stage, "done");
  assert.equal(result.prUrl, "https://github.com/o/r/pull/1");
  assert.deepEqual([calls.branch, calls.agent, calls.prove, calls.commit, calls.pr.length], [1, 1, 1, 1, 1]);
  // The PR was opened WITH the passing proof (the gate's contract).
  assert.equal(calls.pr[0].proof.success, true);
  assert.match(calls.pr[0].title, /Fix: 500 on \/pay/);
});

test("runIssueToPr: a failed proof STOPS before commit/PR (no proof, no PR)", async () => {
  const { deps, calls } = issueDeps({
    proveCode: async () => ({ success: false, errors: [{ type: "BUILD_FAILED", message: "tsc" }], durationMs: 1 }),
  });
  const result = await runIssueToPr(EVENT, CONFIG, deps);

  assert.equal(result.success, false);
  assert.equal(result.stage, "proof");
  assert.match(result.error, /BUILD_FAILED/);
  assert.equal(calls.commit, 0, "nothing committed without a proof");
  assert.equal(calls.pr.length, 0, "no PR opened without a proof");
});

test("runIssueToPr: a failed agent fix stops at 'agent' (never proves or PRs)", async () => {
  const { deps, calls } = issueDeps({
    runAgent: async () => ({ success: false, steps: [], stepsUsed: 3, lastError: "could not fix it" }),
  });
  const result = await runIssueToPr(EVENT, CONFIG, deps);
  assert.equal(result.stage, "agent");
  assert.equal(result.success, false);
  assert.equal(calls.prove, 0);
  assert.equal(calls.pr.length, 0);
});

test("runIssueToPr: a branch failure is reported structurally", async () => {
  const { deps } = issueDeps({
    createBranch: async () => {
      throw new Error("branch already exists");
    },
  });
  const result = await runIssueToPr(EVENT, CONFIG, deps);
  assert.equal(result.stage, "branch");
  assert.equal(result.success, false);
  assert.match(result.error, /already exists/);
});

test("buildFixGoal instructs the agent NOT to open the PR itself", () => {
  const goal = buildFixGoal(EVENT);
  assert.match(goal, /500 on \/pay/);
  assert.match(goal, /Do NOT open a pull request yourself/i);
});

// ── scheduler ──────────────────────────────────────────────────────────────────

test("createScheduler fires a job on an interval and stop() halts it", async () => {
  const scheduler = createScheduler();
  let count = 0;
  scheduler.schedule("tick", 15, () => {
    count++;
  });
  await delay(80);
  const afterRunning = count;
  assert.ok(afterRunning >= 2, `job fired repeatedly (got ${afterRunning})`);

  scheduler.stop("tick");
  await delay(60);
  assert.equal(count, afterRunning, "no more firings after stop()");
  scheduler.stopAll();
});

test("createScheduler isolates a throwing job (the loop survives)", async () => {
  const scheduler = createScheduler();
  let fired = 0;
  scheduler.schedule("boom", 15, () => {
    fired++;
    throw new Error("job blew up");
  });
  await delay(70);
  scheduler.stopAll();
  assert.ok(fired >= 2, "a throwing job keeps being scheduled, not killed");
});

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
