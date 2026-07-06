/**
 * ProofCast LLM planner — the `API_KEY`-mode strategy for {@link runAgent}.
 *
 * {@link createLlmPlanner} turns whichever provider the user connected (Anthropic,
 * OpenAI, or any compatible endpoint — via src/ai.ts, so it stays multi-provider
 * and never pre-selects a model) into an {@link AgentPlanner}. Each turn it:
 *   1. describes the tool catalogue + the strict decision contract in the system
 *      prompt,
 *   2. sends the goal and the (capped) history of observations as the user turn,
 *   3. parses the model's reply into a {@link PlannerDecision}.
 *
 * The reply is a single JSON object — either a `tool_call` or a `finish`. Real
 * models wrap JSON in ```fences or add prose, so {@link parsePlannerDecision} is
 * defensive (isolate the outermost object, tolerate a fence) and throws a clear
 * {@link InvalidPlannerResponseError} on anything malformed; runAgent catches that
 * and fails the run cleanly rather than looping on garbage.
 *
 * In `AGENT_SUBSCRIPTION` mode this planner is NOT used (ProofCast makes no LLM
 * call): the calling agent is the planner and drives the tools itself.
 */

import { generateFeature as defaultGenerateFeature, type GenerateFeatureOptions } from "./ai.js";
import type { AgentObservation, AgentPlanner, PlannerDecision } from "./agent.js";
import type { ToolSpec } from "./tools/registry.js";

/** Cap on how much observation history is echoed back to the model each turn. */
export const DEFAULT_MAX_HISTORY_CHARS = 6000;

/** Cap on how much of a single tool result is summarized into the history. */
export const MAX_RESULT_CHARS = 800;

/** Thrown when the model's reply is not a valid {@link PlannerDecision}. */
export class InvalidPlannerResponseError extends Error {
  constructor(reason: string) {
    super(`The planner model did not return a valid decision: ${reason}.`);
    this.name = "InvalidPlannerResponseError";
  }
}

export interface LlmPlannerOptions {
  /** Injected generation fn (default: ai.ts generateFeature). Tests pass a fake. */
  generate?: (description: string, options: GenerateFeatureOptions) => Promise<string>;
  /** Provider to use (instance | "anthropic" | "openai"); defaults to env/auto. */
  provider?: GenerateFeatureOptions["provider"];
  /** Model override (else the provider's env var decides). */
  model?: string;
  /** Max output tokens for a decision (a decision is small). */
  maxTokens?: number;
  /** Cap on echoed history (default {@link DEFAULT_MAX_HISTORY_CHARS}). */
  maxHistoryChars?: number;
}

/** Build an {@link AgentPlanner} backed by a real LLM. */
export function createLlmPlanner(options: LlmPlannerOptions = {}): AgentPlanner {
  const generate = options.generate ?? defaultGenerateFeature;
  const maxHistoryChars = options.maxHistoryChars ?? DEFAULT_MAX_HISTORY_CHARS;

  return {
    async decide(goal, tools, history): Promise<PlannerDecision> {
      const text = await generate(buildUserMessage(goal, history, maxHistoryChars), {
        provider: options.provider,
        model: options.model,
        maxTokens: options.maxTokens,
        system: buildSystemPrompt(tools),
        // The loop manages its own history; don't also inject project memory here.
        memory: false,
      });
      return parsePlannerDecision(text);
    },
  };
}

/** System prompt: the tool catalogue + the exact JSON decision contract. */
export function buildSystemPrompt(tools: ToolSpec[]): string {
  const catalogue = tools
    .map((t) => `- ${t.name}: ${t.description}\n  input schema: ${JSON.stringify(t.inputSchema)}`)
    .join("\n");
  return (
    "You are ProofCast's autonomous agent. Work towards the user's goal by calling tools " +
    "ONE AT A TIME, observing each result, and continuing until the goal is done.\n\n" +
    "Available tools:\n" +
    `${catalogue}\n\n` +
    "On EVERY turn, reply with ONLY a single JSON object — no prose, no markdown fences — " +
    "in one of these two shapes:\n" +
    '  {"action":"tool_call","tool":"<tool name>","input":{...},"thought":"<why, one sentence>"}\n' +
    '  {"action":"finish","summary":"<what you accomplished>"}\n\n' +
    "Rules: use only the tools listed above; put the tool's arguments in \"input\" per its " +
    "schema; call \"finish\" as soon as the goal is achieved or cannot proceed. A tool result " +
    'of {"ok":false} means it failed — read the error and adapt; do not repeat the same failing call.'
  );
}

/** User turn: the goal, then the capped history of what has happened so far. */
export function buildUserMessage(goal: string, history: AgentObservation[], maxHistoryChars: number): string {
  if (history.length === 0) {
    return `Goal: ${goal}\n\nNo actions taken yet. Decide the first action.`;
  }
  const lines = history.map((obs, i) => {
    const outcome = obs.result.ok
      ? `ok ${capResult(JSON.stringify(obs.result.output ?? null))}`
      : `error ${capResult(obs.result.error ?? "")}`;
    return `${i + 1}. ${obs.tool}(${capResult(JSON.stringify(obs.input))}) -> ${outcome}`;
  });
  const historyBlock = capHistory(lines, maxHistoryChars);
  return `Goal: ${goal}\n\nHistory so far:\n${historyBlock}\n\nDecide the next action.`;
}

/**
 * Parse a model reply into a {@link PlannerDecision}. Tolerates a ```json fence or
 * surrounding prose by isolating the outermost JSON object.
 * @throws {InvalidPlannerResponseError} on anything malformed.
 */
export function parsePlannerDecision(text: string): PlannerDecision {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new InvalidPlannerResponseError("empty response");
  }
  let body = text.trim();
  const fenced = body.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenced?.[1]) {
    body = fenced[1].trim();
  }
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new InvalidPlannerResponseError("no JSON object found");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (err) {
    throw new InvalidPlannerResponseError(`invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new InvalidPlannerResponseError("top-level value is not an object");
  }

  const record = parsed as Record<string, unknown>;
  const action = record.action;

  if (action === "finish") {
    if (typeof record.summary !== "string") {
      throw new InvalidPlannerResponseError('"finish" requires a string "summary"');
    }
    return { type: "finish", summary: record.summary };
  }

  if (action === "tool_call") {
    if (typeof record.tool !== "string" || record.tool.trim().length === 0) {
      throw new InvalidPlannerResponseError('"tool_call" requires a non-empty "tool" name');
    }
    const input = "input" in record ? record.input : {};
    const thought = typeof record.thought === "string" ? record.thought : undefined;
    return { type: "tool_call", tool: record.tool, input, thought };
  }

  throw new InvalidPlannerResponseError(`unknown action ${JSON.stringify(action)} (expected "tool_call" or "finish")`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Truncate a single serialized value for the history block. */
function capResult(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text;
}

/** Keep the MOST RECENT history lines within `maxChars` (older steps drop first). */
function capHistory(lines: string[], maxChars: number): string {
  const kept: string[] = [];
  let budget = maxChars;
  for (const line of [...lines].reverse()) {
    if (line.length + 1 > budget && kept.length > 0) break;
    kept.unshift(line);
    budget -= line.length + 1;
  }
  const dropped = lines.length - kept.length;
  return dropped > 0 ? `… (${dropped} earlier step(s) elided)\n${kept.join("\n")}` : kept.join("\n");
}
