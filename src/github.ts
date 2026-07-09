/**
 * ProofCast GitHub orchestration — branch, commit, and the PROOF-GATED pull request.
 *
 * This is where ProofCast's discipline reaches the outside world: {@link openProvenPullRequest}
 * refuses to open a PR unless it is handed a SUCCESSFUL {@link ProofReport}, and it
 * stamps the proof reference into the PR body. That is the whole differentiator —
 * *"a PR that arrives with a video proof; no proof, no PR"* — expressed as code.
 *
 * All git/gh work goes through an injectable {@link CommandRunner} (default: `spawn`,
 * no shell → no injection surface), so the whole module is tested without touching
 * a real repository, network, or the `gh` CLI. Commit messages are passed verbatim —
 * ProofCast adds no co-author/attribution trailer.
 */

import { spawn } from "node:child_process";

import type { ProofReport } from "./prover.js";

/** Captured result of running a command. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Injectable command transport (no shell). */
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<CommandResult>;

/** Default per-command wall-clock cap (gh can hang on auth). */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/** Thrown when a git/gh command exits non-zero. */
export class GitCommandError extends Error {
  readonly result: CommandResult;
  constructor(command: string, result: CommandResult) {
    super(`\`${command}\` failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(-500)}`);
    this.name = "GitCommandError";
    this.result = result;
  }
}

/** Thrown by {@link openProvenPullRequest} when there is no passing proof. */
export class UnprovenPullRequestError extends Error {
  constructor() {
    super(
      "Refusing to open a pull request without a successful proof (proof-before-deploy). " +
        "Record a passing proof first, then open the PR.",
    );
    this.name = "UnprovenPullRequestError";
  }
}

export interface GitHubOptions {
  /** Repository working directory. */
  cwd?: string;
  /** Injected command runner (default: real `spawn`). */
  exec?: CommandRunner;
  /** Per-command timeout (default {@link DEFAULT_GIT_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/** Real command runner: spawn (no shell), capture stdout/stderr/exit, bounded. */
export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => {
      if (stdout.length < 200_000) stdout += String(c);
    });
    child.stderr?.on("data", (c) => {
      if (stderr.length < 200_000) stderr += String(c);
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectPromise(new Error(`\`${command} ${args.join(" ")}\` timed out after ${options.timeoutMs} ms.`));
      }, options.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }

    child.once("error", (err) => {
      if (timer) clearTimeout(timer);
      rejectPromise(err);
    });
    child.once("exit", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

function execOf(options: GitHubOptions): { run: CommandRunner; cwd?: string; timeoutMs: number } {
  return {
    run: options.exec ?? runCommand,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  };
}

/** Create and switch to a new branch. @throws {GitCommandError} on failure. */
export async function createBranch(name: string, options: GitHubOptions = {}): Promise<void> {
  const { run, cwd, timeoutMs } = execOf(options);
  const res = await run("git", ["switch", "-c", name], { cwd, timeoutMs });
  if (res.exitCode !== 0) {
    throw new GitCommandError(`git switch -c ${name}`, res);
  }
}

/**
 * Stage everything and commit. A "nothing to commit" state is NOT an error — it
 * resolves with `{ committed: false }`. @throws {GitCommandError} on a real failure.
 */
export async function commitAll(message: string, options: GitHubOptions = {}): Promise<{ committed: boolean }> {
  const { run, cwd, timeoutMs } = execOf(options);

  const add = await run("git", ["add", "-A"], { cwd, timeoutMs });
  if (add.exitCode !== 0) {
    throw new GitCommandError("git add -A", add);
  }

  const commit = await run("git", ["commit", "-m", message], { cwd, timeoutMs });
  if (commit.exitCode !== 0) {
    if (/nothing to commit|no changes added/i.test(`${commit.stdout}\n${commit.stderr}`)) {
      return { committed: false };
    }
    throw new GitCommandError("git commit", commit);
  }
  return { committed: true };
}

export interface OpenPullRequestInput {
  title: string;
  body?: string;
  /** Base branch to merge into (gh default: the repo default branch). */
  base?: string;
  /** Head branch to open from (gh default: the current branch). */
  head?: string;
}

/** Open a PR via `gh pr create` and return its URL. @throws {GitCommandError} on failure. */
export async function openPullRequest(
  input: OpenPullRequestInput,
  options: GitHubOptions = {},
): Promise<{ url: string }> {
  const { run, cwd, timeoutMs } = execOf(options);
  const args = ["pr", "create", "--title", input.title, "--body", input.body ?? ""];
  if (input.base) args.push("--base", input.base);
  if (input.head) args.push("--head", input.head);

  const res = await run("gh", args, { cwd, timeoutMs });
  if (res.exitCode !== 0) {
    throw new GitCommandError("gh pr create", res);
  }
  return { url: extractPrUrl(res.stdout) ?? res.stdout.trim() };
}

export interface ProvenPullRequestInput extends OpenPullRequestInput {
  /** The proof that must have PASSED. Without `success`, no PR is opened. */
  proof: ProofReport;
  /** A reference to the proof (video path/URL) cited in the PR body. */
  proofRef?: string;
}

/**
 * Open a pull request ONLY when handed a passing proof, stamping the proof
 * reference into the body — the proof-before-deploy gate on an outward action.
 * @throws {UnprovenPullRequestError} when `proof.success` is not true.
 */
export async function openProvenPullRequest(
  input: ProvenPullRequestInput,
  options: GitHubOptions = {},
): Promise<{ url: string }> {
  if (!input.proof || input.proof.success !== true) {
    throw new UnprovenPullRequestError();
  }
  const proofNote =
    `🎬 **Proof:** ${input.proofRef ?? "a passing recorded proof"} — verified by ProofCast ` +
    "before this PR was opened.";
  const body = input.body ? `${input.body}\n\n---\n${proofNote}` : proofNote;
  return openPullRequest({ title: input.title, body, base: input.base, head: input.head }, options);
}

/** Pull the PR URL out of `gh pr create` output. */
function extractPrUrl(output: string): string | null {
  return /https?:\/\/\S*\/pull\/\d+/.exec(output)?.[0] ?? null;
}
