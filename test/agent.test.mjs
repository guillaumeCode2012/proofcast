import test from "node:test";
import assert from "node:assert/strict";

import { runAgent, AgentTimeoutError, MAX_TRACE_CHARS, DEFAULT_MAX_STEPS } from "../dist/agent.js";
import { ToolRegistry, ok, fail } from "../dist/tools/index.js";

/** A registry with one recording echo tool (+ optional extras). */
function toolSetup(extraTools = []) {
  const invocations = [];
  const registry = new ToolRegistry().register({
    name: "echo",
    description: "Echo the input back.",
    inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
    run: async (input) => {
      invocations.push(input);
      return ok({ echoed: input?.msg ?? null });
    },
  });
  for (const t of extraTools) registry.register(t);
  return { registry, invocations, ctx: { root: "/jail" } };
}

/** A planner that replays a scripted list of decisions, recording what it saw. */
function scriptedPlanner(decisions) {
  const seen = [];
  let i = 0;
  return {
    seen,
    decide: async (goal, tools, history) => {
      seen.push({ goal, tools, history: [...history] });
      const d = decisions[Math.min(i, decisions.length - 1)];
      i++;
      return typeof d === "function" ? d() : d;
    },
  };
}

const silent = () => {};

test("runAgent: tool_call then finish → success, trace recorded, result fed back to the planner", async () => {
  const { registry, invocations, ctx } = toolSetup();
  const planner = scriptedPlanner([
    { type: "tool_call", tool: "echo", input: { msg: "hi" }, thought: "let's echo" },
    { type: "finish", summary: "Echoed successfully." },
  ]);

  const result = await runAgent("echo hi", planner, registry, ctx, { log: silent });

  assert.equal(result.success, true);
  assert.equal(result.summary, "Echoed successfully.");
  assert.equal(result.stepsUsed, 1);
  assert.equal(result.steps.length, 1);
  assert.deepEqual(result.steps[0].input, { msg: "hi" });
  assert.equal(result.steps[0].thought, "let's echo");
  assert.equal(result.steps[0].result.ok, true);
  assert.deepEqual(invocations, [{ msg: "hi" }], "the tool really ran once");

  // The 2nd planner call saw the 1st observation (structured feedback loop).
  assert.equal(planner.seen.length, 2);
  assert.equal(planner.seen[0].history.length, 0);
  assert.equal(planner.seen[1].history.length, 1);
  assert.deepEqual(planner.seen[1].history[0].result.output, { echoed: "hi" });
  // The planner also received the tool catalogue.
  assert.deepEqual(planner.seen[0].tools.map((t) => t.name), ["echo"]);
});

test("runAgent: immediate finish → success with zero steps", async () => {
  const { registry, invocations, ctx } = toolSetup();
  const planner = scriptedPlanner([{ type: "finish", summary: "Nothing to do." }]);
  const result = await runAgent("noop", planner, registry, ctx, { log: silent });
  assert.equal(result.success, true);
  assert.equal(result.stepsUsed, 0);
  assert.equal(invocations.length, 0);
});

test("runAgent: the step budget is a hard bound (never while(true))", async () => {
  const { registry, ctx } = toolSetup();
  const planner = scriptedPlanner([{ type: "tool_call", tool: "echo", input: { msg: "again" } }]);
  const result = await runAgent("loop forever", planner, registry, ctx, { maxSteps: 3, log: silent });

  assert.equal(result.success, false);
  assert.equal(result.stepsUsed, 3, "exactly maxSteps tool calls");
  assert.match(result.lastError, /budget exhausted \(3 steps\)/i);
});

test("runAgent: an invalid maxSteps falls back to the default", async () => {
  const { registry, ctx } = toolSetup();
  const planner = scriptedPlanner([{ type: "tool_call", tool: "echo", input: { msg: "x" } }]);
  const result = await runAgent("loop", planner, registry, ctx, { maxSteps: -5, log: silent });
  assert.equal(result.stepsUsed, DEFAULT_MAX_STEPS);
});

test("runAgent: the global timeout rescues a hung planner and returns the trace so far", async () => {
  const { registry, ctx } = toolSetup();
  const planner = scriptedPlanner([
    { type: "tool_call", tool: "echo", input: { msg: "first" } },
    () => new Promise(() => {}), // hangs forever on the 2nd decide
  ]);
  const result = await runAgent("hang please", planner, registry, ctx, { timeoutMs: 150, log: silent });

  assert.equal(result.success, false);
  assert.match(result.lastError, /timeout/i);
  assert.equal(result.stepsUsed, 1, "the trace up to the hang is preserved");
});

test("runAgent: a planner throw fails the run cleanly (no crash)", async () => {
  const { registry, ctx } = toolSetup();
  const planner = {
    decide: async () => {
      throw new Error("model refused");
    },
  };
  const result = await runAgent("goal", planner, registry, ctx, { log: silent });
  assert.equal(result.success, false);
  assert.match(result.lastError, /Planner failed at step 1.*model refused/);
});

test("runAgent: an unknown tool is fed back as ok:false and the loop continues", async () => {
  const { registry, ctx } = toolSetup();
  const planner = scriptedPlanner([
    { type: "tool_call", tool: "does_not_exist", input: {} },
    { type: "finish", summary: "Recovered." },
  ]);
  const result = await runAgent("recover", planner, registry, ctx, { log: silent });

  assert.equal(result.success, true, "the loop survived the bad tool name");
  assert.equal(result.steps[0].result.ok, false);
  assert.match(result.steps[0].result.error, /Unknown tool/);
  // The planner saw the failure and could adapt.
  assert.equal(planner.seen[1].history[0].result.ok, false);
});

test("runAgent: the guard vetoes a tool BEFORE it executes and the planner sees the reason", async () => {
  const { registry, invocations, ctx } = toolSetup();
  const planner = scriptedPlanner([
    { type: "tool_call", tool: "echo", input: { msg: "deploy!" } },
    { type: "finish", summary: "Understood, demo first." },
  ]);
  const guard = (tool) =>
    tool === "echo" ? { allow: false, reason: "Déploie est bloqué tant qu'aucune Démo n'existe." } : { allow: true };

  const result = await runAgent("ship it", planner, registry, ctx, { guard, log: silent });

  assert.equal(invocations.length, 0, "the vetoed tool NEVER executed");
  assert.equal(result.steps[0].result.ok, false);
  assert.match(result.steps[0].result.error, /Démo/);
  assert.equal(result.success, true, "the planner adapted after the veto");
});

test("runAgent: a guard that THROWS blocks the tool (fail-closed), the run survives", async () => {
  const { registry, invocations, ctx } = toolSetup();
  const planner = scriptedPlanner([
    { type: "tool_call", tool: "echo", input: { msg: "x" } },
    { type: "finish", summary: "adapted" },
  ]);
  const guard = () => {
    throw new Error("gate storage corrupted");
  };
  const result = await runAgent("g", planner, registry, ctx, { guard, log: silent });

  assert.equal(invocations.length, 0, "a broken gate NEVER lets the tool through");
  assert.equal(result.steps[0].result.ok, false);
  assert.match(result.steps[0].result.error, /fail-closed.*gate storage corrupted/i);
  assert.equal(result.success, true, "the run continued cleanly");
});

test("runAgent: an async guard is awaited", async () => {
  const { registry, invocations, ctx } = toolSetup();
  const planner = scriptedPlanner([
    { type: "tool_call", tool: "echo", input: { msg: "x" } },
    { type: "finish", summary: "done" },
  ]);
  const guard = async () => ({ allow: false, reason: "async veto" });
  const result = await runAgent("g", planner, registry, ctx, { guard, log: silent });
  assert.equal(invocations.length, 0);
  assert.match(result.steps[0].result.error, /async veto/);
});

test("runAgent validates its goal", async () => {
  const { registry, ctx } = toolSetup();
  const planner = scriptedPlanner([{ type: "finish", summary: "x" }]);
  await assert.rejects(() => runAgent("", planner, registry, ctx, { log: silent }), TypeError);
  await assert.rejects(() => runAgent("   ", planner, registry, ctx, { log: silent }), TypeError);
});

test("runAgent: trace lines are size-capped even for a huge tool result", async () => {
  const lines = [];
  const big = "z".repeat(10_000);
  const { registry, ctx } = toolSetup([
    {
      name: "huge",
      description: "returns a huge payload",
      inputSchema: {},
      run: async () => ok({ blob: big }),
    },
  ]);
  const planner = scriptedPlanner([
    { type: "tool_call", tool: "huge", input: {} },
    { type: "finish", summary: "done" },
  ]);
  await runAgent("big output", planner, registry, ctx, { log: (l) => lines.push(l) });

  const stepLine = lines.find((l) => l.includes("huge("));
  assert.ok(stepLine, "the step was traced");
  assert.ok(
    stepLine.length < MAX_TRACE_CHARS + 200,
    `trace line stays bounded (got ${stepLine.length} chars)`,
  );
  assert.match(stepLine, /\[\+\d+ chars\]/, "flags the truncation");
});

test("runAgent: a broken log sink never breaks the run", async () => {
  const { registry, ctx } = toolSetup();
  const planner = scriptedPlanner([
    { type: "tool_call", tool: "echo", input: { msg: "x" } },
    { type: "finish", summary: "done" },
  ]);
  const result = await runAgent("g", planner, registry, ctx, {
    log: () => {
      throw new Error("disk full");
    },
  });
  assert.equal(result.success, true, "tracing is best-effort");
});

test("AgentTimeoutError names the elapsed budget", () => {
  assert.match(new AgentTimeoutError(4321).message, /4321 ms/);
});
