/**
 * Pilot tool — delegate a task to ANOTHER coding agent (Claude Code, Codex).
 *
 * `pilot_agent` generalizes the `AGENT_SUBSCRIPTION` idea: ProofCast can drive a
 * task into the user's own agent CLI (which carries their subscription) and capture
 * the result, so the ProofCast loop can orchestrate sub-agents — e.g. "have Codex
 * fix this file, then I'll prove it". The agent name is checked against an
 * allow-list (default `claude`, `codex`) so the tool can only invoke known CLIs.
 *
 * The runner is injected (tests never spawn anything). The default runs the agent
 * CLI on the HOST — deliberately, unlike `shell_run`: these are TRUSTED, user-
 * installed CLIs holding the user's auth, not arbitrary model-generated commands.
 */

import { fail, ok, type Tool } from "./registry.js";
import { runCommand } from "../github.js";

/** Runs a sub-agent CLI with a task and returns its combined output + exit code. */
export type AgentRunner = (
  agent: string,
  task: string,
  options: { cwd: string; timeoutMs?: number },
) => Promise<{ output: string; exitCode: number }>;

/** Default per-pilot wall-clock cap. */
export const DEFAULT_PILOT_TIMEOUT_MS = 10 * 60_000;

export interface PilotToolOptions {
  /** Agent CLIs that may be invoked (default: `["claude", "codex"]`). */
  allowedAgents?: string[];
  /** Injected runner (default: run the agent CLI on the host). */
  runner?: AgentRunner;
  /** Per-pilot timeout (default {@link DEFAULT_PILOT_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/** The sub-agent orchestration tool: `pilot_agent`. */
export function createPilotTool(options: PilotToolOptions = {}): Tool {
  const allowed = new Set((options.allowedAgents ?? ["claude", "codex"]).map((a) => a.toLowerCase()));
  const runner = options.runner ?? defaultAgentRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PILOT_TIMEOUT_MS;

  return {
    name: "pilot_agent",
    description:
      `Delegate a task to another coding agent CLI (${[...allowed].join(", ")}) and capture its output. ` +
      "Use to have a sub-agent make a change, then prove it yourself.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: `Which agent CLI to run (${[...allowed].join(" | ")}).` },
        task: { type: "string", description: "The task/prompt to hand the sub-agent." },
      },
      required: ["agent", "task"],
    },
    async run(input, ctx) {
      const agent = readStringProp(input, "agent");
      if (agent === undefined) return fail('pilot_agent requires a non-empty "agent" string.');
      if (!allowed.has(agent.toLowerCase())) {
        return fail(`pilot_agent: agent ${JSON.stringify(agent)} is not allowed. Allowed: ${[...allowed].join(", ")}.`);
      }
      const task = readStringProp(input, "task");
      if (task === undefined) return fail('pilot_agent requires a non-empty "task" string.');

      try {
        const result = await runner(agent.toLowerCase(), task, { cwd: ctx.root, timeoutMs });
        return ok({ agent: agent.toLowerCase(), exitCode: result.exitCode, output: result.output });
      } catch (err) {
        return fail(`pilot_agent could not run ${JSON.stringify(agent)}: ${errMessage(err)}`);
      }
    },
  };
}

/** Default runner: invoke the trusted agent CLI on the host, passing the task as one arg. */
async function defaultAgentRunner(
  agent: string,
  task: string,
  options: { cwd: string; timeoutMs?: number },
): Promise<{ output: string; exitCode: number }> {
  const res = await runCommand(agent, [task], { cwd: options.cwd, timeoutMs: options.timeoutMs });
  return { output: `${res.stdout}${res.stderr}`.trim(), exitCode: res.exitCode };
}

/** Read a required non-empty string property from untrusted model input. */
function readStringProp(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Message of an unknown error value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
