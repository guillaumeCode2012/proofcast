/**
 * Shell tool — run a command inside the isolated Docker sandbox.
 *
 * `shell_run` is the agent's "execute a command" capability, and it is
 * sandbox-only BY DESIGN: the command runs to completion inside a throwaway
 * `node:20-alpine` container ({@link runInSandbox}) with the project root
 * bind-mounted — never on the host. Model-generated commands therefore cannot
 * touch the user's machine.
 *
 * Contract: a NON-ZERO exit code is a normal result (returned in `output.exitCode`),
 * not a tool failure — the agent inspects it and decides. The tool only fails
 * (`ok:false`) when the sandbox itself can't run the command (Docker down, etc.).
 */

import { runInSandbox, type SandboxRunResult } from "../sandbox.js";
import { fail, ok, type Tool } from "./registry.js";

/** Injectable sandbox runner, so tests never need a real Docker daemon. */
export type SandboxRunner = (
  codeDir: string,
  command: string,
  options: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    image?: string;
    network?: "none" | "bridge" | "host";
  },
) => Promise<SandboxRunResult>;

export interface ShellToolOptions {
  /** Override the sandbox runner (default {@link runInSandbox}). */
  runner?: SandboxRunner;
  /** Wall-clock cap per command (ms). */
  timeoutMs?: number;
  /** Byte cap on captured output. */
  maxOutputBytes?: number;
  /** Override the container image. */
  image?: string;
  /**
   * Container network for the command. Omit for the Docker default (needed for
   * `npm install`); set `"none"` to run commands with NO network access.
   */
  network?: "none" | "bridge" | "host";
}

/** The sandboxed shell tool: `shell_run`. */
export function createShellTool(options: ShellToolOptions = {}): Tool {
  const runner = options.runner ?? runInSandbox;
  return {
    name: "shell_run",
    description:
      "Run a shell command inside an isolated Docker sandbox (node:20-alpine), with the project " +
      "root bind-mounted. Returns the exit code and combined output. Never runs on the host.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run inside the sandbox." },
      },
      required: ["command"],
    },
    async run(input, ctx) {
      const command = readStringProp(input, "command");
      if (command === undefined) {
        return fail('shell_run requires a non-empty "command" string.');
      }
      try {
        const result = await runner(ctx.root, command, {
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
          image: options.image,
          network: options.network,
        });
        return ok({
          exitCode: result.exitCode,
          output: result.output,
          timedOut: result.timedOut,
          truncated: result.truncated,
        });
      } catch (err) {
        // The sandbox itself couldn't run it (Docker missing/down, create failure).
        return fail(`shell_run could not execute in the sandbox: ${errMessage(err)}`);
      }
    },
  };
}

/** Read a required non-empty string property from untrusted model input. */
function readStringProp(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Message of an unknown error value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
