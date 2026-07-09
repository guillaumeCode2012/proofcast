import test from "node:test";
import assert from "node:assert/strict";

import {
  commitAll,
  createBranch,
  openPullRequest,
  openProvenPullRequest,
  GitCommandError,
  UnprovenPullRequestError,
} from "../dist/github.js";
import { createProofGate } from "../dist/gate.js";
import { runAgent } from "../dist/agent.js";
import { ToolRegistry, ok, createGitHubTools, createPilotTool } from "../dist/tools/index.js";

/** A fake command runner scripted per `command args…` key. */
function fakeExec(script) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    const key = `${command} ${args.join(" ")}`;
    for (const [pattern, result] of Object.entries(script)) {
      if (key.startsWith(pattern)) return { stdout: "", stderr: "", exitCode: 0, ...result };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { run, calls };
}

const OK = { stdout: "", stderr: "", exitCode: 0 };

// ── git ops ─────────────────────────────────────────────────────────────────

test("createBranch runs `git switch -c` and throws on failure", async () => {
  const good = fakeExec({ "git switch -c": OK });
  await createBranch("feat/x", { exec: good.run, cwd: "/repo" });
  assert.deepEqual(good.calls[0].args, ["switch", "-c", "feat/x"]);
  assert.equal(good.calls[0].options.cwd, "/repo");

  const bad = fakeExec({ "git switch -c": { exitCode: 128, stderr: "already exists" } });
  await assert.rejects(() => createBranch("feat/x", { exec: bad.run }), GitCommandError);
});

test("commitAll stages + commits, treats 'nothing to commit' as committed:false", async () => {
  const committed = fakeExec({ "git add": OK, "git commit": { exitCode: 0 } });
  assert.deepEqual(await commitAll("do a thing", { exec: committed.run }), { committed: true });
  assert.deepEqual(committed.calls[1].args, ["commit", "-m", "do a thing"], "message passed verbatim, no trailer");

  const clean = fakeExec({ "git add": OK, "git commit": { exitCode: 1, stdout: "nothing to commit, working tree clean" } });
  assert.deepEqual(await commitAll("noop", { exec: clean.run }), { committed: false });

  const broken = fakeExec({ "git add": OK, "git commit": { exitCode: 1, stderr: "fatal: bad" } });
  await assert.rejects(() => commitAll("x", { exec: broken.run }), GitCommandError);
});

test("commitAll adds NO co-author / attribution trailer", async () => {
  const ex = fakeExec({ "git add": OK, "git commit": OK });
  await commitAll("My message", { exec: ex.run });
  const commitArgs = ex.calls[1].args.join("\n");
  assert.doesNotMatch(commitArgs, /Co-Authored-By/i);
  assert.doesNotMatch(commitArgs, /Claude/i);
});

test("openPullRequest calls gh and extracts the PR url", async () => {
  const ex = fakeExec({ "gh pr create": { stdout: "https://github.com/o/r/pull/42\n" } });
  const { url } = await openPullRequest({ title: "T", body: "B", base: "main" }, { exec: ex.run });
  assert.equal(url, "https://github.com/o/r/pull/42");
  assert.deepEqual(ex.calls[0].args, ["pr", "create", "--title", "T", "--body", "B", "--base", "main"]);

  const fails = fakeExec({ "gh pr create": { exitCode: 1, stderr: "no gh auth" } });
  await assert.rejects(() => openPullRequest({ title: "T" }, { exec: fails.run }), GitCommandError);
});

// ── the proof-gated PR (the differentiator) ───────────────────────────────────

test("openProvenPullRequest REFUSES without a passing proof — and never calls gh", async () => {
  const ex = fakeExec({ "gh pr create": { stdout: "https://x/pull/1" } });
  await assert.rejects(
    () => openProvenPullRequest({ title: "T", proof: { success: false, durationMs: 1 } }, { exec: ex.run }),
    UnprovenPullRequestError,
  );
  await assert.rejects(
    () => openProvenPullRequest({ title: "T", proof: undefined }, { exec: ex.run }),
    UnprovenPullRequestError,
  );
  assert.equal(ex.calls.length, 0, "no PR was opened without a proof");
});

test("openProvenPullRequest opens the PR and stamps the proof into the body", async () => {
  const ex = fakeExec({ "gh pr create": { stdout: "https://github.com/o/r/pull/7" } });
  const { url } = await openProvenPullRequest(
    { title: "Fix bug", body: "Details.", proof: { success: true, durationMs: 5 }, proofRef: "proofcast-proof.mp4" },
    { exec: ex.run },
  );
  assert.equal(url, "https://github.com/o/r/pull/7");
  const body = ex.calls[0].args[ex.calls[0].args.indexOf("--body") + 1];
  assert.match(body, /Details\./);
  assert.match(body, /Proof:.*proofcast-proof\.mp4/);
  assert.match(body, /verified by ProofCast/);
});

// ── proof gate guard ──────────────────────────────────────────────────────────

test("createProofGate blocks protected tools until a proof is ready, allows the rest", () => {
  let ready = false;
  const gate = createProofGate({ protectedTools: ["github_open_pr"], isProofReady: () => ready });

  assert.equal(gate("fs_read").allow, true, "unprotected tool always allowed");
  const blocked = gate("github_open_pr");
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason, /proof-before-deploy/i);
  assert.match(blocked.reason, /github_open_pr/);

  ready = true;
  assert.equal(gate("github_open_pr").allow, true, "allowed once a proof exists");
});

test("proof gate integrates with runAgent: PR blocked until proof, then allowed", async () => {
  const opened = [];
  const registry = new ToolRegistry()
    .register({
      name: "github_open_pr",
      description: "",
      inputSchema: {},
      run: async (input) => {
        opened.push(input);
        return ok({ url: "https://x/pull/1" });
      },
    })
    .register({ name: "prove", description: "", inputSchema: {}, run: async () => ok({ proven: true }) });

  let proofReady = false;
  const gate = createProofGate({ protectedTools: ["github_open_pr"], isProofReady: () => proofReady });

  // The planner tries to open a PR, gets vetoed, "proves", then opens it.
  let step = 0;
  const planner = {
    decide: async () => {
      step++;
      if (step === 1) return { type: "tool_call", tool: "github_open_pr", input: { title: "early" } };
      if (step === 2) {
        proofReady = true; // proving happened
        return { type: "tool_call", tool: "prove", input: {} };
      }
      if (step === 3) return { type: "tool_call", tool: "github_open_pr", input: { title: "proven" } };
      return { type: "finish", summary: "shipped with proof" };
    },
  };

  const result = await runAgent("ship it", planner, registry, { root: "/repo" }, { guard: gate, log: () => {} });
  assert.equal(result.success, true);
  assert.equal(opened.length, 1, "the PR was opened exactly once — only after the proof");
  assert.equal(opened[0].title, "proven", "the early, unproven attempt was vetoed");
  assert.equal(result.steps[0].result.ok, false, "first attempt blocked");
  assert.match(result.steps[0].result.error, /proof-before-deploy/i);
});

// ── github tools ────────────────────────────────────────────────────────────

test("git_commit / github_open_pr tools drive git/gh via the injected exec", async () => {
  const ex = fakeExec({ "git add": OK, "git commit": OK, "gh pr create": { stdout: "https://x/pull/9" } });
  const registry = new ToolRegistry().registerAll(createGitHubTools({ exec: ex.run }));
  const ctx = { root: "/repo" };

  const c = await registry.invoke("git_commit", { message: "wip" }, ctx);
  assert.deepEqual(c.output, { committed: true });

  const pr = await registry.invoke("github_open_pr", { title: "My PR" }, ctx);
  assert.equal(pr.output.url, "https://x/pull/9");

  assert.equal((await registry.invoke("git_commit", {}, ctx)).ok, false, "validates input");
});

test("github tools surface a git failure as ok:false (no throw)", async () => {
  const ex = fakeExec({ "gh pr create": { exitCode: 1, stderr: "gh: not authenticated" } });
  const registry = new ToolRegistry().registerAll(createGitHubTools({ exec: ex.run }));
  const res = await registry.invoke("github_open_pr", { title: "T" }, { root: "/repo" });
  assert.equal(res.ok, false);
  assert.match(res.error, /not authenticated/);
});

// ── pilot_agent ────────────────────────────────────────────────────────────

test("pilot_agent delegates to an allowed sub-agent and returns its output", async () => {
  const runs = [];
  const runner = async (agent, task, opts) => {
    runs.push({ agent, task, opts });
    return { output: "fixed the file", exitCode: 0 };
  };
  const registry = new ToolRegistry().register(createPilotTool({ runner, allowedAgents: ["claude", "codex"] }));

  const res = await registry.invoke("pilot_agent", { agent: "Codex", task: "fix src/x.ts" }, { root: "/repo" });
  assert.equal(res.ok, true);
  assert.equal(res.output.agent, "codex", "agent name normalized");
  assert.equal(res.output.output, "fixed the file");
  assert.equal(runs[0].task, "fix src/x.ts");
  assert.equal(runs[0].opts.cwd, "/repo", "runs in the jail root");
});

test("pilot_agent refuses an agent outside the allow-list, and validates input", async () => {
  let ran = false;
  const runner = async () => {
    ran = true;
    return { output: "", exitCode: 0 };
  };
  const registry = new ToolRegistry().register(createPilotTool({ runner }));
  const ctx = { root: "/repo" };

  const blocked = await registry.invoke("pilot_agent", { agent: "rm-rf-bot", task: "do harm" }, ctx);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /is not allowed/);
  assert.equal(ran, false, "a non-allowlisted agent is never spawned");

  assert.equal((await registry.invoke("pilot_agent", { agent: "claude" }, ctx)).ok, false, "missing task");
});
