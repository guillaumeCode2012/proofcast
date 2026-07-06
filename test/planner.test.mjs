import test from "node:test";
import assert from "node:assert/strict";

import {
  createLlmPlanner,
  parsePlannerDecision,
  buildSystemPrompt,
  buildUserMessage,
  InvalidPlannerResponseError,
} from "../dist/planner.js";
import { runAgent } from "../dist/agent.js";
import { ToolRegistry, ok } from "../dist/tools/index.js";

const TOOLS = [
  { name: "fs_read", description: "Read a file.", inputSchema: { type: "object", required: ["path"] } },
  { name: "shell_run", description: "Run a command.", inputSchema: { type: "object", required: ["command"] } },
];

// ── parsePlannerDecision ───────────────────────────────────────────────────────

test("parses a bare tool_call decision", () => {
  const d = parsePlannerDecision('{"action":"tool_call","tool":"fs_read","input":{"path":"a.txt"},"thought":"read it"}');
  assert.deepEqual(d, { type: "tool_call", tool: "fs_read", input: { path: "a.txt" }, thought: "read it" });
});

test("parses a finish decision", () => {
  assert.deepEqual(parsePlannerDecision('{"action":"finish","summary":"all done"}'), {
    type: "finish",
    summary: "all done",
  });
});

test("tolerates a ```json fence and surrounding prose", () => {
  const fenced = 'Sure!\n```json\n{"action":"finish","summary":"ok"}\n```\nHope that helps.';
  assert.deepEqual(parsePlannerDecision(fenced), { type: "finish", summary: "ok" });
  const prose = 'I will read the file. {"action":"tool_call","tool":"fs_read","input":{"path":"x"}} done.';
  assert.equal(parsePlannerDecision(prose).tool, "fs_read");
});

test("defaults a missing tool_call input to {}", () => {
  const d = parsePlannerDecision('{"action":"tool_call","tool":"fs_list"}');
  assert.deepEqual(d, { type: "tool_call", tool: "fs_list", input: {}, thought: undefined });
});

test("rejects malformed decisions with a clear error", () => {
  assert.throws(() => parsePlannerDecision(""), InvalidPlannerResponseError);
  assert.throws(() => parsePlannerDecision("no json here"), InvalidPlannerResponseError);
  assert.throws(() => parsePlannerDecision("{ not valid json "), InvalidPlannerResponseError);
  assert.throws(() => parsePlannerDecision('{"action":"finish"}'), InvalidPlannerResponseError); // no summary
  assert.throws(() => parsePlannerDecision('{"action":"tool_call"}'), InvalidPlannerResponseError); // no tool
  assert.throws(() => parsePlannerDecision('{"action":"teleport"}'), InvalidPlannerResponseError); // unknown action
});

// ── prompt construction ────────────────────────────────────────────────────────

test("system prompt lists every tool + the decision contract", () => {
  const sys = buildSystemPrompt(TOOLS);
  assert.match(sys, /fs_read: Read a file\./);
  assert.match(sys, /shell_run: Run a command\./);
  assert.match(sys, /"action":"tool_call"/);
  assert.match(sys, /"action":"finish"/);
});

test("user message carries the goal and a capped history", () => {
  const empty = buildUserMessage("do X", [], 6000);
  assert.match(empty, /Goal: do X/);
  assert.match(empty, /No actions taken yet/);

  const withHistory = buildUserMessage(
    "do X",
    [{ tool: "fs_read", input: { path: "a" }, result: { ok: false, error: "missing" } }],
    6000,
  );
  assert.match(withHistory, /1\. fs_read\({"path":"a"}\) -> error missing/);
});

test("user message elides the oldest steps when history is too long", () => {
  const history = Array.from({ length: 50 }, (_, i) => ({
    tool: "shell_run",
    input: { command: `echo step-${i}` },
    result: { ok: true, output: { exitCode: 0, output: "x".repeat(50) } },
  }));
  const msg = buildUserMessage("big", history, 400);
  assert.match(msg, /earlier step\(s\) elided/);
  assert.ok(msg.length < 1200, "the echoed history stays bounded");
});

// ── createLlmPlanner (injected generate) ───────────────────────────────────────

test("createLlmPlanner sends the system+user prompt and parses the reply", async () => {
  const calls = [];
  const generate = async (user, options) => {
    calls.push({ user, options });
    return '{"action":"tool_call","tool":"fs_read","input":{"path":"README.md"}}';
  };
  const planner = createLlmPlanner({ generate });
  const decision = await planner.decide("read the readme", TOOLS, []);

  assert.deepEqual(decision, { type: "tool_call", tool: "fs_read", input: { path: "README.md" }, thought: undefined });
  assert.match(calls[0].options.system, /fs_read/, "tools described in the system prompt");
  assert.match(calls[0].user, /Goal: read the readme/);
  assert.equal(calls[0].options.memory, false, "planner does not inject project memory");
});

test("createLlmPlanner surfaces a malformed reply as an error (runAgent then fails cleanly)", async () => {
  const planner = createLlmPlanner({ generate: async () => "I refuse to output JSON" });
  await assert.rejects(() => planner.decide("goal", TOOLS, []), InvalidPlannerResponseError);
});

// ── end-to-end with the real runAgent loop ─────────────────────────────────────

test("LLM planner drives the real runAgent loop to completion", async () => {
  const registry = new ToolRegistry().register({
    name: "fs_read",
    description: "Read a file.",
    inputSchema: { type: "object", required: ["path"] },
    run: async (input) => ok({ content: `contents of ${input.path}` }),
  });

  // Scripted "model": read a file, then finish once it has seen the content.
  const generate = async (user) =>
    /contents of/.test(user)
      ? '{"action":"finish","summary":"Read the file."}'
      : '{"action":"tool_call","tool":"fs_read","input":{"path":"a.txt"}}';

  const planner = createLlmPlanner({ generate });
  const result = await runAgent("read a.txt", planner, registry, { root: "/jail" }, { log: () => {} });

  assert.equal(result.success, true);
  assert.equal(result.summary, "Read the file.");
  assert.equal(result.stepsUsed, 1);
  assert.deepEqual(result.steps[0].result.output, { content: "contents of a.txt" });
});
