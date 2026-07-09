/**
 * ProofCast daemon — "fix it while you sleep", governed by proof-before-deploy.
 *
 * {@link runIssueToPr} is the end-to-end reaction to an inbound {@link WebhookEvent}
 * (Sentry error, GitHub issue): open a fix branch, drive the agent loop to fix the
 * code, PROVE it, and only then commit and open a pull request. The gate is
 * enforced twice over: the proof must pass before we commit, and
 * {@link openProvenPullRequest} itself refuses to open a PR without a passing proof.
 * So the worst case is "no PR", never "an unproven PR merged while you slept".
 *
 * {@link createScheduler} is the proactive counterpart: run a job on an interval
 * (each firing isolated, timers unref'd so they never keep the process alive on
 * their own). Every heavy step is an injected dependency, so the whole reaction is
 * tested without git, Docker, a browser, or a network.
 */

import {
  commitAll as defaultCommitAll,
  createBranch as defaultCreateBranch,
  openProvenPullRequest as defaultOpenProvenPullRequest,
  type GitHubOptions,
  type ProvenPullRequestInput,
} from "./github.js";
import { runAgent as defaultRunAgent, type AgentPlanner, type AgentResult, type RunAgentOptions, type ToolGuard } from "./agent.js";
import { proveCode as defaultProveCode, type ProofReport } from "./prover.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { WebhookEvent } from "./webhook.js";

/** How far the reaction got (useful for the trace / the caller). */
export type IssueStage = "branch" | "agent" | "proof" | "commit" | "pr" | "done";

export interface IssueToPrResult {
  success: boolean;
  /** The furthest stage reached. `"done"` iff success. */
  stage: IssueStage;
  /** The opened PR URL, on success. */
  prUrl?: string;
  /** Tool steps the agent used to fix the issue. */
  stepsUsed?: number;
  /** Why it stopped, when `success` is false. */
  error?: string;
}

export interface IssueToPrConfig {
  /** The project to fix (brownfield). */
  dirPath: string;
  /** The planner driving the fix. */
  planner: AgentPlanner;
  /** Tools available to the fix run. */
  registry: ToolRegistry;
  /** Guard for the run (typically the proof gate over irreversible tools). */
  guard?: ToolGuard;
  /** Step budget for the fix (forwarded to runAgent). */
  maxSteps?: number;
  /** Branch name prefix (default `proofcast/fix`). */
  branchPrefix?: string;
  /** Base branch for the PR. */
  base?: string;
}

/** Injectable heavy side-effects; defaults are the real implementations. */
export interface IssueToPrDeps {
  createBranch: (name: string, options?: GitHubOptions) => Promise<void>;
  runAgent: (
    goal: string,
    planner: AgentPlanner,
    registry: ToolRegistry,
    ctx: { root: string },
    options?: RunAgentOptions,
  ) => Promise<AgentResult>;
  proveCode: (dirPath: string) => Promise<ProofReport>;
  commitAll: (message: string, options?: GitHubOptions) => Promise<{ committed: boolean }>;
  openProvenPullRequest: (input: ProvenPullRequestInput, options?: GitHubOptions) => Promise<{ url: string }>;
}

/**
 * React to an issue end-to-end: branch → fix (agent) → PROVE → commit → gated PR.
 * Resolves with a structured {@link IssueToPrResult} for every outcome — it does
 * not throw for an expected failure (a failed fix, a failed proof, a git error).
 */
export async function runIssueToPr(
  event: WebhookEvent,
  config: IssueToPrConfig,
  deps: Partial<IssueToPrDeps> = {},
): Promise<IssueToPrResult> {
  const d = withDefaults(deps);
  const ctx = { root: config.dirPath };
  const branch = `${config.branchPrefix ?? "proofcast/fix"}-${slug(event.title)}-${Date.now()}`;

  try {
    await d.createBranch(branch, { cwd: config.dirPath });
  } catch (err) {
    return { success: false, stage: "branch", error: errMessage(err) };
  }

  const agentResult = await d.runAgent(buildFixGoal(event), config.planner, config.registry, ctx, {
    guard: config.guard,
    maxSteps: config.maxSteps,
  });
  if (!agentResult.success) {
    return { success: false, stage: "agent", stepsUsed: agentResult.stepsUsed, error: agentResult.lastError };
  }

  // THE GATE: no proof, no PR. A failed proof stops here — nothing is committed.
  const proof = await d.proveCode(config.dirPath);
  if (!proof.success) {
    return {
      success: false,
      stage: "proof",
      stepsUsed: agentResult.stepsUsed,
      error: `Proof failed: ${summarizeProof(proof)}`,
    };
  }

  try {
    await d.commitAll(`Fix: ${event.title}`, { cwd: config.dirPath });
  } catch (err) {
    return { success: false, stage: "commit", stepsUsed: agentResult.stepsUsed, error: errMessage(err) };
  }

  try {
    const { url } = await d.openProvenPullRequest(
      {
        title: `Fix: ${event.title}`,
        body: buildPrBody(event, agentResult),
        base: config.base,
        proof,
        proofRef: "proofcast-proof.mp4",
      },
      { cwd: config.dirPath },
    );
    return { success: true, stage: "done", prUrl: url, stepsUsed: agentResult.stepsUsed };
  } catch (err) {
    return { success: false, stage: "pr", stepsUsed: agentResult.stepsUsed, error: errMessage(err) };
  }
}

// ── scheduler (proactive automation) ─────────────────────────────────────────

export interface Scheduler {
  /** (Re)schedule `fn` to run every `intervalMs`. Re-scheduling the same name replaces it. */
  schedule(name: string, intervalMs: number, fn: () => void | Promise<void>): void;
  /** Stop a scheduled job. */
  stop(name: string): void;
  /** Stop every scheduled job. */
  stopAll(): void;
}

/** A minimal interval scheduler: each firing is isolated, timers are unref'd. */
export function createScheduler(): Scheduler {
  const timers = new Map<string, ReturnType<typeof setInterval>>();

  const stop = (name: string): void => {
    const timer = timers.get(name);
    if (timer) {
      clearInterval(timer);
      timers.delete(name);
    }
  };

  return {
    schedule(name, intervalMs, fn) {
      stop(name);
      const timer = setInterval(() => {
        // Isolate each firing: a throwing/rejecting job must not kill the loop.
        void Promise.resolve()
          .then(fn)
          .catch(() => {});
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
      timers.set(name, timer);
    },
    stop,
    stopAll() {
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function withDefaults(deps: Partial<IssueToPrDeps>): IssueToPrDeps {
  return {
    createBranch: deps.createBranch ?? defaultCreateBranch,
    runAgent: deps.runAgent ?? defaultRunAgent,
    proveCode: deps.proveCode ?? ((dirPath: string) => defaultProveCode(dirPath)),
    commitAll: deps.commitAll ?? defaultCommitAll,
    openProvenPullRequest: deps.openProvenPullRequest ?? defaultOpenProvenPullRequest,
  };
}

/** Build the fix goal handed to the agent from a normalized event. */
export function buildFixGoal(event: WebhookEvent): string {
  const where = event.detail ? ` (context: ${event.detail})` : "";
  const link = event.url ? `\nReference: ${event.url}` : "";
  return (
    `A ${event.source} ${event.kind} was reported: "${event.title}"${where}.${link}\n\n` +
    "Investigate the project, fix the root cause, and stop once you are confident it is resolved. " +
    "Do NOT open a pull request yourself — ProofCast records the proof and opens the gated PR after you finish."
  );
}

/** Build the PR body citing the source event + the agent's work. */
function buildPrBody(event: WebhookEvent, agentResult: AgentResult): string {
  const lines = [
    `Automated fix for a ${event.source} ${event.kind}: **${event.title}**.`,
    event.url ? `\nSource: ${event.url}` : "",
    `\nResolved by the ProofCast agent in ${agentResult.stepsUsed} step(s).`,
    agentResult.summary ? `\n\n${agentResult.summary}` : "",
  ];
  return lines.filter((l) => l.length > 0).join("");
}

/** A short, filesystem/branch-safe slug of a title. */
function slug(title: string): string {
  const s = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s.length > 0 ? s : "issue";
}

/** One-line summary of a failed proof for the result. */
function summarizeProof(proof: ProofReport): string {
  const first = proof.errors?.[0];
  return first ? `[${first.type}] ${first.message}` : "unknown proof failure";
}

/** Message of an unknown error value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
