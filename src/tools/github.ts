/**
 * GitHub tools — commit and open a pull request, for the agent loop.
 *
 * `github_open_pr` is an IRREVERSIBLE, outward action: it is meant to run behind
 * the proof gate (src/gate.ts), which vetoes it in the loop until a passing proof
 * exists. The tool itself just performs the git/gh call via the injectable runner,
 * returning a structured result — never throwing at the loop.
 */

import { fail, ok, type Tool } from "./registry.js";
import { commitAll, openPullRequest, GitCommandError, type CommandRunner } from "../github.js";

export interface GitHubToolsOptions {
  /** Injected command runner (default: real git/gh via spawn). */
  exec?: CommandRunner;
  /** Per-command timeout. */
  timeoutMs?: number;
}

/** The GitHub tools: `git_commit`, `github_open_pr`. */
export function createGitHubTools(options: GitHubToolsOptions = {}): Tool[] {
  return [gitCommitTool(options), openPrTool(options)];
}

function gitCommitTool(options: GitHubToolsOptions): Tool {
  return {
    name: "git_commit",
    description: "Stage all changes and commit them with a message. A no-op when there is nothing to commit.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "The commit message." } },
      required: ["message"],
    },
    async run(input, ctx) {
      const message = readStringProp(input, "message");
      if (message === undefined) return fail('git_commit requires a non-empty "message" string.');
      try {
        const result = await commitAll(message, { cwd: ctx.root, exec: options.exec, timeoutMs: options.timeoutMs });
        return ok(result);
      } catch (err) {
        if (err instanceof GitCommandError) return fail(err.message);
        return fail(`git_commit failed: ${errMessage(err)}`);
      }
    },
  };
}

function openPrTool(options: GitHubToolsOptions): Tool {
  return {
    name: "github_open_pr",
    description:
      "Open a GitHub pull request via gh and return its URL. IRREVERSIBLE — gated by proof-before-deploy in the loop.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "PR title." },
        body: { type: "string", description: "PR description (optional)." },
        base: { type: "string", description: "Base branch to merge into (optional)." },
      },
      required: ["title"],
    },
    async run(input) {
      const title = readStringProp(input, "title");
      if (title === undefined) return fail('github_open_pr requires a non-empty "title" string.');
      const body = readStringProp(input, "body");
      const base = readStringProp(input, "base");
      try {
        const { url } = await openPullRequest(
          { title, body, base },
          { exec: options.exec, timeoutMs: options.timeoutMs },
        );
        return ok({ url });
      } catch (err) {
        if (err instanceof GitCommandError) return fail(err.message);
        return fail(`github_open_pr failed: ${errMessage(err)}`);
      }
    },
  };
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
