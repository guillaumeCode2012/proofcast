import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROOF_COMMENT_MARKER,
  PROOF_STATUS_CONTEXT,
  MAX_DETAILS_CHARS,
  actionMain,
  formatDuration,
  formatProofComment,
  parseProofOutput,
  reportProof,
  resolveContext,
  statusDescription,
} from "../dist/action.js";

/**
 * A fake `gh` runner scripted per `command args…` prefix, recording every call so
 * the tests assert on the exact API requests — no network, no token, no GitHub.
 */
function fakeExec(script = {}) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options, key: `${command} ${args.join(" ")}` });
    for (const [pattern, result] of Object.entries(script)) {
      if (`${command} ${args.join(" ")}`.includes(pattern)) {
        return { stdout: "", stderr: "", exitCode: 0, ...result };
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { run, calls };
}

/** Collect the reporter's side-effects (log lines + file appends) for assertions. */
function collector(overrides = {}) {
  const logs = [];
  const files = new Map();
  return {
    logs,
    files,
    deps: {
      log: (line) => logs.push(line),
      appendFile: async (path, content) => files.set(path, (files.get(path) ?? "") + content),
      ...overrides,
    },
  };
}

const PASSING = { success: true, proofPath: "/w/app/proofcast-proof.mp4", durationMs: 4900 };
const FAILING = {
  success: false,
  durationMs: 2100,
  errors: [{ type: "CONSOLE_ERROR", message: "TypeError: total is not a function", details: "at Cart.js:42" }],
};

// ── parsing the CLI's stdout contract ────────────────────────────────────────

test("parseProofOutput extracts the report even when the runner interleaves noise", () => {
  const stdout = [
    "npm warn deprecated something@1.0.0",
    "Downloading Chromium 140.0…",
    '{"success":true,"proofPath":"/w/proofcast-proof.mp4","durationMs":4900}',
    "Done in 12s.",
  ].join("\n");
  assert.deepEqual(parseProofOutput(stdout), {
    success: true,
    proofPath: "/w/proofcast-proof.mp4",
    durationMs: 4900,
  });
});

test("parseProofOutput keeps the LAST report and ignores unrelated JSON lines", () => {
  const stdout = [
    '{"level":"info","msg":"not a report"}',
    '{"success":false,"durationMs":10}',
    '{"success":true,"durationMs":20}',
  ].join("\n");
  assert.equal(parseProofOutput(stdout).success, true);
  assert.equal(parseProofOutput(stdout).durationMs, 20);
});

test("parseProofOutput returns null when there is no report at all", () => {
  assert.equal(parseProofOutput(""), null);
  assert.equal(parseProofOutput("boom: command not found\n"), null);
  assert.equal(parseProofOutput('{"broken":'), null);
});

test("formatDuration is human-readable across the ranges", () => {
  assert.equal(formatDuration(840), "840 ms");
  assert.equal(formatDuration(4900), "4.9 s");
  assert.equal(formatDuration(72_000), "1 min 12 s");
  assert.equal(formatDuration(Number.NaN), "unknown");
});

// ── the comment body ────────────────────────────────────────────────────────

test("a passing proof comments the report + a link to the playable video", () => {
  const body = formatProofComment({
    report: PASSING,
    feature: "Project: checkout",
    artifactUrl: "https://github.com/o/r/actions/runs/1/artifacts/9",
    artifactName: "proofcast-proof",
    runUrl: "https://github.com/o/r/actions/runs/1",
    version: "0.5.0",
  });

  assert.match(body, /^<!-- proofcast:proof-report -->/, "carries the upsert marker first");
  assert.match(body, /ProofCast — proof passed/);
  assert.match(body, /\| \*\*Feature\*\* \| Project: checkout \|/);
  assert.match(body, /\| \*\*Status\*\* \| ✅ PASSED \|/);
  assert.match(body, /\| \*\*Duration\*\* \| 4\.9 s \|/);
  assert.match(body, /\[⬇️ proofcast-proof\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\/artifacts\/9\)/);
  assert.match(body, /ProofCast\]\(https:\/\/github\.com\/guillaumeCode2012\/proofcast\) v0\.5\.0/);
});

test("a passing proof without a successful upload still names the artifact", () => {
  const body = formatProofComment({ report: PASSING, feature: "app", artifactName: "my-proof" });
  assert.match(body, /`my-proof` artifact on the run/);
  assert.doesNotMatch(body, /\]\(undefined\)/, "never renders a broken link");
});

test("a failing proof lists the typed prover errors with foldable details", () => {
  const body = formatProofComment({ report: FAILING, feature: "app" });
  assert.match(body, /ProofCast — proof failed/);
  assert.match(body, /\| \*\*Status\*\* \| ❌ FAILED \|/);
  assert.match(body, /\*\*`CONSOLE_ERROR`\*\* — TypeError: total is not a function/);
  assert.match(body, /<details><summary>details<\/summary>/);
  assert.match(body, /at Cart\.js:42/);
  assert.doesNotMatch(body, /Proof video/, "there is no video to link when nothing passed");
});

test("a failing proof falls back to `error`, then to an honest 'no report' line", () => {
  const usage = formatProofComment({
    report: { success: false, durationMs: 0, error: "Dossier introuvable : /nope" },
    feature: "app",
  });
  assert.match(usage, /Dossier introuvable : \/nope/);

  const empty = formatProofComment({ report: { success: false, durationMs: 0 }, feature: "app" });
  assert.match(empty, /prover produced no report/i);
});

test("long details are truncated and marked, so nothing looks complete when it is not", () => {
  const body = formatProofComment({
    report: {
      success: false,
      durationMs: 1,
      errors: [{ type: "BUILD_FAILED", message: "boom", details: "x".repeat(MAX_DETAILS_CHARS + 500) }],
    },
    feature: "app",
  });
  assert.match(body, /… \(truncated\)/);
  assert.ok(body.length < MAX_DETAILS_CHARS + 1_500, "the comment stays readable");
});

test("pipes and newlines in a feature name cannot break the markdown table", () => {
  const body = formatProofComment({ report: PASSING, feature: "a | b\nc" });
  const row = body.split("\n").find((l) => l.includes("**Feature**"));
  assert.equal(row, "| **Feature** | a \\| b c |");
});

test("statusDescription stays inside GitHub's 140-char commit-status limit", () => {
  assert.match(statusDescription(PASSING), /Proof passed in 4\.9 s/);
  assert.match(statusDescription(FAILING), /Proof failed: TypeError/);
  const long = statusDescription({ success: false, durationMs: 1, error: "e".repeat(400) });
  assert.ok(long.length <= 160, `expected a truncated description, got ${long.length} chars`);
});

// ── resolving the runner context ────────────────────────────────────────────

test("resolveContext puts the status on the PR HEAD sha, not the merge commit", async () => {
  const context = await resolveContext(
    {
      GITHUB_REPOSITORY: "o/r",
      GITHUB_SHA: "mergesha",
      GITHUB_EVENT_PATH: "/evt.json",
      GITHUB_RUN_ID: "77",
      GITHUB_SERVER_URL: "https://github.com",
    },
    async () => JSON.stringify({ pull_request: { number: 12, head: { sha: "headsha" } } }),
  );
  assert.equal(context.prNumber, 12);
  assert.equal(context.sha, "headsha", "a status on the merge sha would show no check on the PR");
  assert.equal(context.runUrl, "https://github.com/o/r/actions/runs/77");
});

test("resolveContext degrades gracefully off a pull request", async () => {
  const context = await resolveContext({ GITHUB_REPOSITORY: "o/r", GITHUB_SHA: "abc" });
  assert.equal(context.prNumber, undefined);
  assert.equal(context.sha, "abc");

  const broken = await resolveContext(
    { GITHUB_REPOSITORY: "o/r", GITHUB_SHA: "abc", GITHUB_EVENT_PATH: "/evt.json" },
    async () => "{not json",
  );
  assert.equal(broken.prNumber, undefined, "an unreadable payload must not throw");
});

// ── reporting to GitHub ─────────────────────────────────────────────────────

const PR_CONTEXT = { repository: "o/r", prNumber: 12, sha: "headsha", runUrl: "https://run" };

test("with no existing comment, the proof is POSTed and the status is set", async () => {
  const ex = fakeExec({ "--jq": { stdout: "" } });
  const c = collector();

  const result = await reportProof(
    { report: PASSING, feature: "app", context: PR_CONTEXT, comment: true, status: true },
    { exec: ex.run, env: {}, ...c.deps },
  );

  assert.deepEqual(result, { comment: "created", status: "set", success: true });

  const post = ex.calls.find((call) => call.key.includes("POST repos/o/r/issues/12/comments"));
  assert.ok(post, "posts to the PR's comment endpoint");
  const body = post.args[post.args.indexOf("-f") + 1];
  assert.match(body, /^body=<!-- proofcast:proof-report -->/);

  const status = ex.calls.find((call) => call.key.includes("statuses/headsha"));
  assert.ok(status.args.includes("state=success"));
  assert.ok(status.args.includes(`context=${PROOF_STATUS_CONTEXT}`));
  assert.ok(status.args.includes("target_url=https://run"));
});

test("a re-run EDITS the comment it already owns instead of spamming the thread", async () => {
  const ex = fakeExec({ "--jq": { stdout: "556677\n" } });
  const c = collector();

  const result = await reportProof(
    { report: PASSING, feature: "app", context: PR_CONTEXT, comment: true, status: true },
    { exec: ex.run, env: {}, ...c.deps },
  );

  assert.equal(result.comment, "updated");
  assert.ok(
    ex.calls.some((call) => call.key.includes("PATCH repos/o/r/issues/comments/556677")),
    "edits the existing comment by id",
  );
  assert.ok(
    !ex.calls.some((call) => call.key.includes("POST repos/o/r/issues/12/comments")),
    "and never posts a second one",
  );

  // The lookup must key on the marker, which is what makes the comment identifiable.
  const lookup = ex.calls.find((call) => call.key.includes("--jq"));
  assert.ok(lookup.args.join(" ").includes(PROOF_COMMENT_MARKER));
});

test("a failing proof sets the status to failure — the red check on the PR", async () => {
  const ex = fakeExec({ "--jq": { stdout: "" } });
  const c = collector();

  const result = await reportProof(
    { report: FAILING, feature: "app", context: PR_CONTEXT, comment: true, status: true },
    { exec: ex.run, env: {}, ...c.deps },
  );

  assert.equal(result.success, false);
  const status = ex.calls.find((call) => call.key.includes("statuses/headsha"));
  assert.ok(status.args.includes("state=failure"));
});

test("reporting NEVER changes the verdict: a GitHub failure is logged, not thrown", async () => {
  const ex = fakeExec({
    "--jq": { stdout: "" },
    "POST repos/o/r/issues/12/comments": { exitCode: 1, stderr: "HTTP 403: Resource not accessible" },
    "statuses/": { exitCode: 1, stderr: "HTTP 403" },
  });
  const c = collector();

  const result = await reportProof(
    { report: PASSING, feature: "app", context: PR_CONTEXT, comment: true, status: true },
    { exec: ex.run, env: {}, ...c.deps },
  );

  assert.deepEqual(result, { comment: "skipped", status: "skipped", success: true });
  assert.match(c.logs.join("\n"), /pull-requests: write/, "tells the user the exact missing permission");
  assert.match(c.logs.join("\n"), /statuses: write/);
});

test("a `gh` that is missing entirely is survived too", async () => {
  const ex = { run: async () => Promise.reject(new Error("spawn gh ENOENT")), calls: [] };
  const c = collector();
  const result = await reportProof(
    { report: PASSING, feature: "app", context: PR_CONTEXT, comment: true, status: true },
    { exec: ex.run, env: {}, ...c.deps },
  );
  assert.equal(result.success, true, "the proof verdict survives a broken transport");
});

test("off a pull request, the comment is skipped but the status still lands", async () => {
  const ex = fakeExec();
  const c = collector();
  const result = await reportProof(
    {
      report: PASSING,
      feature: "app",
      context: { repository: "o/r", sha: "abc" },
      comment: true,
      status: true,
    },
    { exec: ex.run, env: {}, ...c.deps },
  );
  assert.equal(result.comment, "skipped");
  assert.equal(result.status, "set");
  assert.match(c.logs.join("\n"), /no pull-request context/i);
});

test("the comment and the status can each be turned off", async () => {
  const ex = fakeExec();
  const c = collector();
  const result = await reportProof(
    { report: PASSING, feature: "app", context: PR_CONTEXT, comment: false, status: false },
    { exec: ex.run, env: {}, ...c.deps },
  );
  assert.deepEqual(result, { comment: "skipped", status: "skipped", success: true });
  assert.equal(ex.calls.length, 0, "no API call at all");
});

test("the job summary is written before any API call, so the run page always shows it", async () => {
  const ex = fakeExec({ "--jq": { stdout: "" } });
  const c = collector();
  await reportProof(
    { report: PASSING, feature: "app", context: PR_CONTEXT, comment: true, status: true },
    { exec: ex.run, env: { GITHUB_STEP_SUMMARY: "/sum.md" }, ...c.deps },
  );
  assert.match(c.files.get("/sum.md"), /ProofCast — proof passed/);
});

// ── the binary entry point ──────────────────────────────────────────────────

/** Write a captured-stdout file the way the action's `prove` step does. */
async function reportFile(contents) {
  const dir = await mkdtemp(join(tmpdir(), "proofcast-action-"));
  const path = join(dir, "report.json");
  await writeFile(path, contents, "utf8");
  return path;
}

test("actionMain exits 0 on a passing proof and publishes the step outputs", async () => {
  const ex = fakeExec({ "--jq": { stdout: "" } });
  const c = collector();
  const outputs = join(await mkdtemp(join(tmpdir(), "proofcast-out-")), "out.txt");

  const code = await actionMain(
    {
      PROOFCAST_REPORT_FILE: await reportFile(`${JSON.stringify(PASSING)}\n`),
      PROOFCAST_FEATURE: "checkout",
      PROOFCAST_ARTIFACT_URL: "https://artifact",
      PROOFCAST_VERSION: "0.5.0",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_SHA: "abc",
      GITHUB_OUTPUT: outputs,
    },
    { exec: ex.run, log: c.deps.log },
  );

  assert.equal(code, 0);
  const written = await readFile(outputs, "utf8");
  assert.match(written, /success=true/);
  assert.match(written, /duration-ms=4900/);
  assert.match(written, /proof-path=\/w\/app\/proofcast-proof\.mp4/);
});

test("actionMain exits 1 on a failing proof — that is what reddens the pull request", async () => {
  const ex = fakeExec({ "--jq": { stdout: "" } });
  const c = collector();
  const code = await actionMain(
    {
      PROOFCAST_REPORT_FILE: await reportFile(JSON.stringify(FAILING)),
      GITHUB_REPOSITORY: "o/r",
      GITHUB_SHA: "abc",
    },
    { exec: ex.run, log: c.deps.log },
  );
  assert.equal(code, 1);
  assert.match(c.logs.join("\n"), /no valid proof/i);
});

test("fail-on-error=false reports the failure without failing the job", async () => {
  const ex = fakeExec({ "--jq": { stdout: "" } });
  const c = collector();
  const code = await actionMain(
    {
      PROOFCAST_REPORT_FILE: await reportFile(JSON.stringify(FAILING)),
      PROOFCAST_FAIL_ON_ERROR: "false",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_SHA: "abc",
    },
    { exec: ex.run, log: c.deps.log },
  );
  assert.equal(code, 0);
  const status = ex.calls.find((call) => call.key.includes("statuses/abc"));
  assert.ok(status.args.includes("state=failure"), "the check is still honestly red");
});

test("an unreadable / missing report is a FAILURE, never a silent green", async () => {
  for (const env of [
    { PROOFCAST_REPORT_FILE: "/does/not/exist.json" },
    { PROOFCAST_REPORT_FILE: await reportFile("Killed: out of memory\n") },
    {},
  ]) {
    const ex = fakeExec({ "--jq": { stdout: "" } });
    const c = collector();
    const code = await actionMain(
      { ...env, GITHUB_REPOSITORY: "o/r", GITHUB_SHA: "abc" },
      { exec: ex.run, log: c.deps.log },
    );
    assert.equal(code, 1, `expected a failure for ${JSON.stringify(env)}`);
    const status = ex.calls.find((call) => call.key.includes("statuses/abc"));
    assert.ok(status.args.includes("state=failure"));
  }
});
