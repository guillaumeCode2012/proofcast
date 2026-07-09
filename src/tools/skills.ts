/**
 * Skill + preference tools — how the agent manages its own long-term knowledge.
 *
 * `save_skill` is the "it writes its own skills" capability: when the agent works
 * out a reusable procedure, it persists it (via {@link SkillStore}) so a later run
 * can `list_skills` / `load_skill` and re-apply it. `remember_preference` persists
 * a durable user preference (see src/memory.ts), which the planner injects into its
 * system prompt on subsequent runs.
 *
 * Same tool-layer contract as everywhere: untrusted input is validated, and every
 * result is structured — an expected failure is `{ ok:false }`, never a throw.
 */

import { fail, ok, type Tool } from "./registry.js";
import { InvalidSkillNameError, type SkillStore } from "../skills.js";
import { writePreference, type PreferenceOptions } from "../memory.js";

/** The skill-management tools driving a shared {@link SkillStore}. */
export function createSkillTools(store: SkillStore): Tool[] {
  return [saveSkillTool(store), listSkillsTool(store), loadSkillTool(store), deleteSkillTool(store)];
}

function saveSkillTool(store: SkillStore): Tool {
  return {
    name: "save_skill",
    description:
      "Persist a reusable skill (a named, described procedure you worked out) so future runs can reuse it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique name: letters/digits/_/-, starts alphanumeric." },
        description: { type: "string", description: "One-line summary of what the skill does." },
        content: { type: "string", description: "The reusable steps/instructions." },
      },
      required: ["name", "content"],
    },
    async run(input) {
      const name = readStringProp(input, "name");
      if (name === undefined) return fail('save_skill requires a non-empty "name" string.');
      const content = readStringProp(input, "content");
      if (content === undefined) return fail('save_skill requires non-empty "content".');
      const description = readStringProp(input, "description") ?? "";
      try {
        const skill = await store.save({ name, description, content });
        return ok({ name: skill.name, description: skill.description });
      } catch (err) {
        if (err instanceof InvalidSkillNameError) return fail(err.message);
        return fail(`save_skill failed: ${errMessage(err)}`);
      }
    },
  };
}

function listSkillsTool(store: SkillStore): Tool {
  return {
    name: "list_skills",
    description: "List every saved skill (name + description) available to reuse.",
    inputSchema: { type: "object", properties: {}, required: [] },
    async run() {
      try {
        return ok({ skills: await store.list() });
      } catch (err) {
        return fail(`list_skills failed: ${errMessage(err)}`);
      }
    },
  };
}

function loadSkillTool(store: SkillStore): Tool {
  return {
    name: "load_skill",
    description: "Load a saved skill by name, returning its full reusable content.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The skill's name." } },
      required: ["name"],
    },
    async run(input) {
      const name = readStringProp(input, "name");
      if (name === undefined) return fail('load_skill requires a non-empty "name" string.');
      const skill = await store.load(name);
      if (!skill) return fail(`No skill named ${JSON.stringify(name)} was found.`);
      return ok(skill);
    },
  };
}

function deleteSkillTool(store: SkillStore): Tool {
  return {
    name: "delete_skill",
    description: "Delete a saved skill by name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The skill's name." } },
      required: ["name"],
    },
    async run(input) {
      const name = readStringProp(input, "name");
      if (name === undefined) return fail('delete_skill requires a non-empty "name" string.');
      return ok({ deleted: await store.remove(name) });
    },
  };
}

/**
 * The `remember_preference` tool: persist a durable, cross-project user preference
 * that the planner will honor on later runs. `options` targets the store (a temp
 * home in tests).
 */
export function createPreferenceTool(options: PreferenceOptions = {}): Tool {
  return {
    name: "remember_preference",
    description:
      "Persist a durable USER preference (how the user likes things done) so future runs respect it automatically.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The preference, one sentence." } },
      required: ["text"],
    },
    async run(input) {
      const text = readStringProp(input, "text");
      if (text === undefined) return fail('remember_preference requires a non-empty "text" string.');
      try {
        writePreference(text, options);
        return ok({ remembered: text });
      } catch (err) {
        return fail(`remember_preference failed: ${errMessage(err)}`);
      }
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

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
