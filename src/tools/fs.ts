/**
 * Filesystem tools — read / write / list, all jailed to the tool root.
 *
 * These are the first concrete {@link Tool}s. Every path goes through
 * {@link resolveInRoot}, so a model that supplies `../../secrets` gets a clean
 * `{ ok:false }` instead of touching anything outside the project. Reads and
 * listings are byte/entry-capped so a huge file or directory can't blow up the
 * agent's context window.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  fail,
  ok,
  resolveInRoot,
  ToolPathEscapeError,
  type Tool,
  type ToolResult,
} from "./registry.js";

/** Default cap on `fs_read` output — a full file is still counted in `bytes`. */
export const DEFAULT_MAX_READ_BYTES = 100_000;

/** Default cap on `fs_list` entries returned. */
export const DEFAULT_MAX_LIST_ENTRIES = 500;

export interface FsToolsOptions {
  /** Byte cap on `fs_read` output (default {@link DEFAULT_MAX_READ_BYTES}). */
  maxReadBytes?: number;
  /** Entry cap on `fs_list` output (default {@link DEFAULT_MAX_LIST_ENTRIES}). */
  maxListEntries?: number;
}

/** The jailed filesystem tools: `fs_read`, `fs_write`, `fs_list`. */
export function createFsTools(options: FsToolsOptions = {}): Tool[] {
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxListEntries = options.maxListEntries ?? DEFAULT_MAX_LIST_ENTRIES;
  return [fsReadTool(maxReadBytes), fsWriteTool(), fsListTool(maxListEntries)];
}

function fsReadTool(maxBytes: number): Tool {
  return {
    name: "fs_read",
    description: "Read a UTF-8 text file inside the project root. Output is truncated past a byte cap.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "File path, relative to the project root." } },
      required: ["path"],
    },
    async run(input, ctx) {
      const path = readStringProp(input, "path");
      if (path === undefined) return fail('fs_read requires a non-empty "path" string.');

      const resolved = resolveOrFail(ctx.root, path);
      if (resolved.error) return resolved.error;

      try {
        const buf = await readFile(resolved.target);
        const truncated = buf.length > maxBytes;
        return ok({
          path,
          bytes: buf.length,
          truncated,
          content: buf.subarray(0, maxBytes).toString("utf8"),
        });
      } catch (err) {
        return fail(`Could not read ${JSON.stringify(path)}: ${errMessage(err)}`);
      }
    },
  };
}

function fsWriteTool(): Tool {
  return {
    name: "fs_write",
    description: "Write a UTF-8 text file inside the project root, creating parent directories.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the project root." },
        content: { type: "string", description: "Full new UTF-8 contents of the file." },
      },
      required: ["path", "content"],
    },
    async run(input, ctx) {
      const path = readStringProp(input, "path");
      if (path === undefined) return fail('fs_write requires a non-empty "path" string.');
      const content = readContentProp(input);
      if (content === undefined) return fail('fs_write requires a "content" string.');

      const resolved = resolveOrFail(ctx.root, path);
      if (resolved.error) return resolved.error;

      try {
        await mkdir(dirname(resolved.target), { recursive: true });
        await writeFile(resolved.target, content, "utf8");
        return ok({ path, bytes: Buffer.byteLength(content, "utf8") });
      } catch (err) {
        return fail(`Could not write ${JSON.stringify(path)}: ${errMessage(err)}`);
      }
    },
  };
}

function fsListTool(maxEntries: number): Tool {
  return {
    name: "fs_list",
    description: "List the entries of a directory inside the project root (defaults to the root).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path, relative to the project root (default: root)." },
      },
      required: [],
    },
    async run(input, ctx) {
      const path = readStringProp(input, "path") ?? ".";

      const resolved = resolveOrFail(ctx.root, path);
      if (resolved.error) return resolved.error;

      try {
        const dirents = await readdir(resolved.target, { withFileTypes: true });
        const entries = dirents.slice(0, maxEntries).map((d) => ({
          name: d.name,
          type: d.isDirectory() ? ("dir" as const) : ("file" as const),
        }));
        return ok({ path, entries, truncated: dirents.length > maxEntries });
      } catch (err) {
        return fail(`Could not list ${JSON.stringify(path)}: ${errMessage(err)}`);
      }
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Resolve `path` inside `root`, turning a jail escape into a failed ToolResult. */
function resolveOrFail(root: string, path: string): { target: string; error?: ToolResult } {
  try {
    return { target: resolveInRoot(root, path) };
  } catch (err) {
    if (err instanceof ToolPathEscapeError) {
      return { target: "", error: fail(err.message) };
    }
    throw err;
  }
}

/** Read a required non-empty string property from untrusted model input. */
function readStringProp(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read the `content` property (an empty string is valid, unlike a path). */
function readContentProp(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>).content;
  return typeof value === "string" ? value : undefined;
}

/** Message of an unknown error value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
