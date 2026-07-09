/**
 * ProofCast skills — the agent's self-written, reusable procedures.
 *
 * A {@link Skill} is a named, described chunk of reusable instructions the agent
 * figured out once and persisted (via the `save_skill` tool, src/tools/skills.ts)
 * so a later run can look it up and re-apply it instead of re-deriving it. Skills
 * live as one JSON file each under `~/.proofcast/skills/`, USER-scoped (they follow
 * the user across projects, like preferences).
 *
 * {@link SkillStore} is the persistence layer (save / list / load / remove), with:
 *   - a strict, filesystem-safe name (no path traversal via a skill name),
 *   - redaction of the stored description/content (same discipline as memory),
 *   - a byte cap so one skill can't bloat the store or a prompt.
 *
 * {@link runSkill} is the "run" verb: it loads a skill and drives {@link runAgent}
 * with the skill's body as the goal. Skills therefore depend on the agent loop,
 * but the loop never depends on skills — no cycle.
 */

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { redactSecrets } from "./memory.js";
import { runAgent, type AgentPlanner, type AgentResult, type RunAgentOptions } from "./agent.js";
import type { ToolContext, ToolRegistry } from "./tools/registry.js";

/** A reusable, agent-authored procedure. */
export interface Skill {
  /** Filesystem-safe unique name (lower-cased). */
  name: string;
  /** One-line description of what the skill does. */
  description: string;
  /** The reusable body: the steps/instructions to apply. */
  content: string;
  /** ISO timestamp of when it was saved. */
  createdAt: string;
}

/** A lightweight catalogue entry (no body), for listing. */
export interface SkillSummary {
  name: string;
  description: string;
}

/** Allowed skill names: 1–64 chars, alnum plus `_`/`-`, starting alphanumeric. */
export const SKILL_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Default byte cap on a single skill's stored content. */
export const DEFAULT_MAX_SKILL_BYTES = 20_000;

/** Thrown when a skill name is not filesystem-safe. */
export class InvalidSkillNameError extends Error {
  constructor(name: string) {
    super(
      `Invalid skill name ${JSON.stringify(name)}. Use 1–64 chars: letters, digits, "_" or "-", ` +
        "starting with a letter or digit.",
    );
    this.name = "InvalidSkillNameError";
  }
}

/** Thrown by {@link runSkill} when the named skill does not exist. */
export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`No skill named ${JSON.stringify(name)} was found.`);
    this.name = "SkillNotFoundError";
  }
}

export interface SkillStoreOptions {
  /** Directory holding the skill files (overrides `homeDir`; used by tests). */
  dir?: string;
  /** Home directory holding `.proofcast/skills/` (defaults to `os.homedir()`). */
  homeDir?: string;
  /** Byte cap on stored content (default {@link DEFAULT_MAX_SKILL_BYTES}). */
  maxContentBytes?: number;
}

/** File-backed store of {@link Skill}s under `~/.proofcast/skills/`. */
export class SkillStore {
  private readonly dir: string;
  private readonly maxBytes: number;

  constructor(options: SkillStoreOptions = {}) {
    this.dir = options.dir ?? join(options.homeDir ?? homedir(), ".proofcast", "skills");
    this.maxBytes = options.maxContentBytes ?? DEFAULT_MAX_SKILL_BYTES;
  }

  /**
   * Persist a skill (overwrites one of the same name). Description and content are
   * redacted; content is required and byte-capped.
   * @throws {InvalidSkillNameError} for an unsafe name.
   * @throws {TypeError} for empty content.
   */
  async save(input: { name: string; description?: string; content: string }): Promise<Skill> {
    const name = normalizeSkillName(input.name);
    const description = redactSecrets(String(input.description ?? "")).trim();

    let content = redactSecrets(String(input.content ?? ""));
    if (content.trim().length === 0) {
      throw new TypeError("A skill requires non-empty content.");
    }
    if (Buffer.byteLength(content, "utf8") > this.maxBytes) {
      content = `${Buffer.from(content, "utf8").subarray(0, this.maxBytes).toString("utf8")}\n… [truncated]`;
    }

    const skill: Skill = { name, description, content, createdAt: new Date().toISOString() };
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${name}.json`), `${JSON.stringify(skill, null, 2)}\n`, "utf8");
    return skill;
  }

  /** List every stored skill's name + description (malformed files are skipped). */
  async list(): Promise<SkillSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return []; // no skills dir yet
    }
    const out: SkillSummary[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(this.dir, file), "utf8")) as Partial<Skill>;
        if (typeof parsed?.name === "string") {
          out.push({ name: parsed.name, description: typeof parsed.description === "string" ? parsed.description : "" });
        }
      } catch {
        /* skip a corrupt skill file rather than failing the whole listing */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Load a skill by name, or `null` if absent / malformed. */
  async load(name: string): Promise<Skill | null> {
    let safe: string;
    try {
      safe = normalizeSkillName(name);
    } catch {
      return null; // an invalid name can't name a stored skill
    }
    try {
      const parsed = JSON.parse(await readFile(join(this.dir, `${safe}.json`), "utf8")) as Partial<Skill>;
      if (typeof parsed?.content !== "string" || typeof parsed?.name !== "string") {
        return null;
      }
      return {
        name: parsed.name,
        description: typeof parsed.description === "string" ? parsed.description : "",
        content: parsed.content,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      };
    } catch {
      return null;
    }
  }

  /** Delete a skill; returns `true` if it existed. */
  async remove(name: string): Promise<boolean> {
    let safe: string;
    try {
      safe = normalizeSkillName(name);
    } catch {
      return false;
    }
    try {
      await unlink(join(this.dir, `${safe}.json`));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Load a saved skill and run it: {@link runAgent} is driven with the skill's body
 * as the goal. This is the "run" of save/list/load/run.
 * @throws {SkillNotFoundError} when the skill does not exist.
 */
export async function runSkill(
  name: string,
  store: SkillStore,
  planner: AgentPlanner,
  registry: ToolRegistry,
  ctx: ToolContext,
  options?: RunAgentOptions,
): Promise<AgentResult> {
  const skill = await store.load(name);
  if (!skill) {
    throw new SkillNotFoundError(name);
  }
  const goal =
    `Apply the saved skill "${skill.name}"` +
    `${skill.description ? ` (${skill.description})` : ""}:\n\n${skill.content}`;
  return runAgent(goal, planner, registry, ctx, options);
}

/** Validate + normalize a skill name to a safe, lower-cased filename stem. */
export function normalizeSkillName(name: string): string {
  const trimmed = String(name ?? "").trim();
  if (!SKILL_NAME_REGEX.test(trimmed)) {
    throw new InvalidSkillNameError(trimmed);
  }
  return trimmed.toLowerCase();
}
