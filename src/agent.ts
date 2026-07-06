/**
 * ProofCast agent loop — the bounded planner → tool → observe cycle.
 *
 * {@link runAgent} is the level-3 primitive on top of the tool layer (src/tools/):
 * a PLANNER (an LLM in `API_KEY` mode — built in step 15.2 — or any injected
 * strategy) looks at the goal, the tool catalogue, and everything observed so far,
 * and decides ONE next action: call a tool, or finish with a summary. The loop
 * executes tool calls through {@link ToolRegistry.invoke} — which never rejects —
 * feeds the structured result back, and repeats.
 *
 * Safety contract (same discipline as executeAndHeal, non-negotiable):
 *   - The loop is a `for` bounded by `maxSteps` — never `while (true)`.
 *   - A global wall-clock timeout caps the whole run; on firing, the run resolves
 *     as a failed {@link AgentResult} (with the trace so far), it does not throw.
 *   - A planner failure (refusal, parse error, network) fails the run cleanly.
 *   - Every step is logged (redacted, size-capped) to `proofcast-live.md`.
 *   - An optional {@link ToolGuard} can veto any tool call BEFORE it executes —
 *     this is the extension point the proof-before-deploy gate plugs into for
 *     irreversible tools (deploy, PR): the veto is fed back to the planner as a
 *     failed result, so the model can react instead of crashing.
 *
 * In `AGENT_SUBSCRIPTION` mode ProofCast never plans (no LLM call): the calling
 * agent IS the loop and drives the tools itself. `runAgent` is the `API_KEY`-mode
 * counterpart.
 */

import { logLiveContext } from "./memory.js";
import type { ToolContext, ToolRegistry, ToolResult, ToolSpec } from "./tools/registry.js";

/** Default cap on planner → tool cycles. */
export const DEFAULT_MAX_STEPS = 10;

/** Default global wall-clock cap for a whole {@link runAgent} run (ms). */
export const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60_000;

/** Cap on how much of a tool input/result is serialized into one trace line. */
export const MAX_TRACE_CHARS = 400;

/** What the planner decides next: act with a tool, or stop with an answer. */
export type PlannerDecision =
  | { type: "tool_call"; tool: string; input: unknown; thought?: string }
  | { type: "finish"; summary: string };

/** One tool call the planner has already seen the outcome of. */
export interface AgentObservation {
  tool: string;
  input: unknown;
  result: ToolResult;
}

/** One executed step of the run (the full trace is returned in {@link AgentResult}). */
export interface AgentStep extends AgentObservation {
  /** 1-based position in the run. */
  index: number;
  /** The planner's stated reasoning for this action, if it gave one. */
  thought?: string;
}

/** The strategy that picks the next action. 15.2 provides the LLM-backed ones. */
export interface AgentPlanner {
  decide(goal: string, tools: ToolSpec[], history: AgentObservation[]): Promise<PlannerDecision>;
}

/**
 * Pre-execution veto for a tool call. Return `{ allow: false, reason }` to block:
 * the tool is NOT executed and the planner sees a failed result carrying `reason`.
 * This is where the proof-before-deploy gate hooks irreversible tools.
 */
export type ToolGuard = (
  tool: string,
  input: unknown,
) => { allow: boolean; reason?: string } | Promise<{ allow: boolean; reason?: string }>;

/** Final outcome of an agent run. Never thrown for an in-run failure. */
export interface AgentResult {
  /** True when the planner finished with a summary within budget. */
  success: boolean;
  /** The planner's final answer (present when `success` is true). */
  summary?: string;
  /** Every executed step, in order (the audit trail of the run). */
  steps: AgentStep[];
  /** Number of tool calls actually executed. */
  stepsUsed: number;
  /** Why the run failed, when `success` is false. */
  lastError?: string;
}

export interface RunAgentOptions {
  /** Cap on planner → tool cycles (default {@link DEFAULT_MAX_STEPS}). */
  maxSteps?: number;
  /** Global wall-clock cap (default {@link DEFAULT_AGENT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Veto hook run before EVERY tool call (default: allow everything). */
  guard?: ToolGuard;
  /** Trace sink (default: redacted `proofcast-live.md` via logLiveContext). */
  log?: (message: string) => void;
}

/** Thrown internally when the global timeout fires; surfaced as a failed result. */
export class AgentTimeoutError extends Error {
  constructor(ms: number) {
    super(`runAgent exceeded its global timeout of ${ms} ms.`);
    this.name = "AgentTimeoutError";
  }
}

/**
 * Run the goal against the registry until the planner finishes, the step budget is
 * spent, or the timeout fires. Resolves with a structured {@link AgentResult} in
 * ALL failure cases — only a blank goal (a programmer error) throws.
 *
 * @throws {TypeError} for a blank goal.
 */
export async function runAgent(
  goal: string,
  planner: AgentPlanner,
  registry: ToolRegistry,
  ctx: ToolContext,
  options: RunAgentOptions = {},
): Promise<AgentResult> {
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new TypeError("A non-empty agent goal is required.");
  }

  const maxSteps =
    Number.isInteger(options.maxSteps) && (options.maxSteps as number) > 0
      ? (options.maxSteps as number)
      : DEFAULT_MAX_STEPS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const guard = options.guard;
  const log = options.log ?? ((message: string) => logLiveContext("agent", message));

  const steps: AgentStep[] = [];
  const history: AgentObservation[] = [];
  const catalogue = registry.catalogue();

  const loop = async (): Promise<AgentResult> => {
    safeLog(log, `goal: ${goal}`);

    for (let index = 1; index <= maxSteps; index++) {
      let decision: PlannerDecision;
      try {
        decision = await planner.decide(goal, catalogue, history);
      } catch (err) {
        const reason = `Planner failed at step ${index}: ${errMessage(err)}`;
        safeLog(log, reason);
        return { success: false, steps, stepsUsed: steps.length, lastError: reason };
      }

      if (decision.type === "finish") {
        safeLog(log, `finished after ${steps.length} step(s): ${cap(decision.summary)}`);
        return { success: true, summary: decision.summary, steps, stepsUsed: steps.length };
      }

      const { tool, input, thought } = decision;

      // Guard: an irreversible tool (deploy, PR…) can be vetoed here; the veto is
      // fed back to the planner as a failed result so it can adapt its plan.
      // FAIL-CLOSED: a guard that throws blocks the tool — a broken gate must
      // never let an irreversible action through.
      let result: ToolResult;
      let verdict: { allow: boolean; reason?: string };
      try {
        verdict = guard ? await guard(tool, input) : { allow: true };
      } catch (err) {
        verdict = { allow: false, reason: `Guard failed (fail-closed): ${errMessage(err)}` };
      }
      if (!verdict.allow) {
        result = { ok: false, error: verdict.reason ?? `Tool ${tool} was blocked by the guard.` };
        safeLog(log, `step ${index}: BLOCKED ${tool} — ${result.error}`);
      } else {
        result = await registry.invoke(tool, input, ctx);
        safeLog(
          log,
          `step ${index}: ${tool}(${cap(safeJson(input))}) → ${result.ok ? "ok" : "error"}: ${cap(
            result.ok ? safeJson(result.output) : (result.error ?? ""),
          )}`,
        );
      }

      const step: AgentStep = { index, tool, input, result, thought };
      steps.push(step);
      history.push({ tool, input, result });
    }

    const reason = `Step budget exhausted (${maxSteps} steps) without the planner finishing.`;
    safeLog(log, reason);
    return { success: false, steps, stepsUsed: steps.length, lastError: reason };
  };

  // Same rescue pattern as executeAndHeal: the timer is NOT unref'd on purpose so
  // it can fire even when the loop hangs on a promise with no live handle.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AgentTimeoutError(timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([loop(), deadline]);
  } catch (err) {
    if (err instanceof AgentTimeoutError) {
      safeLog(log, err.message);
      return { success: false, steps, stepsUsed: steps.length, lastError: err.message };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Log without ever letting a broken sink break the run. */
function safeLog(log: (message: string) => void, message: string): void {
  try {
    log(message);
  } catch {
    /* tracing is best-effort — it must never break the loop */
  }
}

/** JSON-serialize an unknown value defensively (circular structures included). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

/** Cap a string for the trace so a huge tool result can't flood the live log. */
function cap(text: string): string {
  return text.length > MAX_TRACE_CHARS ? `${text.slice(0, MAX_TRACE_CHARS)}… [+${text.length - MAX_TRACE_CHARS} chars]` : text;
}

/** Message of an unknown error value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
