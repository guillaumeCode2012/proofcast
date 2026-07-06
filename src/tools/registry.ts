/**
 * ProofCast tool layer — the typed, jailed primitives an agent loop calls.
 *
 * A {@link Tool} is a single named capability (read a file, run a command in the
 * sandbox, drive a browser…) with a JSON-schema'd input, surfaced to the model for
 * tool-calling. The design has two hard rules that the whole agent loop (built in
 * step 15) relies on:
 *
 *   1. Tools NEVER throw for an *expected* failure — a bad path, a missing file, a
 *      non-zero exit. They return `{ ok: false, error }` so the loop can read the
 *      failure and react, exactly like the prover returns a typed ProofReport.
 *   2. Filesystem access is JAILED. Every path is resolved through
 *      {@link resolveInRoot}, which refuses anything escaping the tool root — the
 *      inputs come from a model, so `../../etc/passwd` must be impossible by design.
 *
 * {@link ToolRegistry.invoke} wraps `tool.run` in a try/catch so even an
 * *unexpected* throw becomes a structured result — invoking a tool never rejects.
 */

import { isAbsolute, relative, resolve } from "node:path";

/** Structured outcome of a tool call. `ok:false` carries a readable `error`. */
export interface ToolResult<O = unknown> {
  ok: boolean;
  output?: O;
  error?: string;
}

/** Build a successful {@link ToolResult}. */
export function ok<O>(output: O): ToolResult<O> {
  return { ok: true, output };
}

/** Build a failed {@link ToolResult} carrying a readable message. */
export function fail(error: string): ToolResult {
  return { ok: false, error };
}

/** Ambient context every tool runs within. `root` jails all filesystem access. */
export interface ToolContext {
  /** Absolute directory every tool is confined to. */
  root: string;
}

/** A single capability the agent can invoke by name with JSON input. */
export interface Tool {
  /** Unique, tool-call-safe name (e.g. `fs_read`). */
  readonly name: string;
  /** One-line description shown to the model when it picks a tool. */
  readonly description: string;
  /** JSON-schema of the input, surfaced to the model for tool-calling. */
  readonly inputSchema: Record<string, unknown>;
  /**
   * Execute the tool. `input` is UNTRUSTED model output — validate it at runtime.
   * Return `{ ok:false, error }` for expected failures; only a genuine bug should throw.
   */
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/** Thrown when two tools share a name at registration (a programmer error). */
export class DuplicateToolError extends Error {
  constructor(name: string) {
    super(`A tool named ${JSON.stringify(name)} is already registered.`);
    this.name = "DuplicateToolError";
  }
}

/** Thrown internally by {@link resolveInRoot} when a path escapes the jail. */
export class ToolPathEscapeError extends Error {
  constructor(path: string) {
    super(`Refusing to access a path outside the tool root: ${JSON.stringify(path)}.`);
    this.name = "ToolPathEscapeError";
  }
}

/**
 * Resolve `p` inside `root`, refusing any path that escapes it (`../…`, an absolute
 * path elsewhere, a different drive on Windows). Returns the absolute, in-jail path.
 * @throws {PathEscapeError} when the resolved target is not under `root`.
 */
export function resolveInRoot(root: string, p: string): string {
  const base = resolve(root);
  const target = resolve(base, p);
  const rel = relative(base, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ToolPathEscapeError(p);
  }
  return target;
}

/** An immutable view of a registered tool, for the model's tool catalogue. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A name-keyed collection of tools the agent loop can list and invoke. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /** Register one tool. @throws {DuplicateToolError} on a name clash. */
  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new DuplicateToolError(tool.name);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  /** Register several tools (e.g. the result of a tool factory). */
  registerAll(tools: Iterable<Tool>): this {
    for (const tool of tools) {
      this.register(tool);
    }
    return this;
  }

  /** True if a tool with `name` is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** The tool registered under `name`, or `undefined`. */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Model-facing catalogue (name + description + schema), in registration order. */
  catalogue(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  /**
   * Invoke a tool by name. An unknown tool OR an unexpected throw from the tool
   * both come back as a structured `{ ok:false }` — this never rejects, so the
   * agent loop can always continue on a clean contract.
   */
  async invoke(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return fail(`Unknown tool: ${JSON.stringify(name)}.`);
    }
    try {
      return await tool.run(input, ctx);
    } catch (err) {
      return fail(`Tool ${name} threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
