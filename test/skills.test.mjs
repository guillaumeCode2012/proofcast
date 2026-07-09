import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  SkillStore,
  runSkill,
  normalizeSkillName,
  InvalidSkillNameError,
  SkillNotFoundError,
} from "../dist/skills.js";
import {
  ToolRegistry,
  ok,
  createSkillTools,
  createPreferenceTool,
} from "../dist/tools/index.js";
import { writePreference, readPreferences, readPreferenceBlock } from "../dist/memory.js";
import { runAgent } from "../dist/agent.js";

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── SkillStore ─────────────────────────────────────────────────────────────────

test("SkillStore: save → list → load → remove round-trip", async () => {
  const dir = tmp("proofcast-skills-");
  try {
    const store = new SkillStore({ dir });
    await store.save({ name: "Deploy-Flow", description: "how to deploy", content: "1. démo\n2. déploie" });

    const list = await store.list();
    assert.deepEqual(list, [{ name: "deploy-flow", description: "how to deploy" }], "name is lower-cased");

    const loaded = await store.load("deploy-flow");
    assert.equal(loaded.content, "1. démo\n2. déploie");
    assert.equal(loaded.name, "deploy-flow");
    assert.ok(loaded.createdAt.length > 0);

    // load is name-normalized (case-insensitive).
    assert.ok(await store.load("DEPLOY-FLOW"));

    assert.equal(await store.remove("deploy-flow"), true);
    assert.equal(await store.remove("deploy-flow"), false, "second remove → false");
    assert.equal(await store.load("deploy-flow"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SkillStore: rejects unsafe names (no path traversal via a skill name)", async () => {
  const dir = tmp("proofcast-skills-");
  try {
    const store = new SkillStore({ dir });
    await assert.rejects(() => store.save({ name: "../evil", content: "x" }), InvalidSkillNameError);
    await assert.rejects(() => store.save({ name: "a/b", content: "x" }), InvalidSkillNameError);
    await assert.rejects(() => store.save({ name: "", content: "x" }), InvalidSkillNameError);
    // load/remove treat an invalid name as "not found", never throwing.
    assert.equal(await store.load("../evil"), null);
    assert.equal(await store.remove("../evil"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SkillStore: empty content is rejected; content is byte-capped", async () => {
  const dir = tmp("proofcast-skills-");
  try {
    await assert.rejects(() => new SkillStore({ dir }).save({ name: "x", content: "   " }), TypeError);

    const store = new SkillStore({ dir, maxContentBytes: 10 });
    const saved = await store.save({ name: "big", content: "0123456789ABCDEF" });
    assert.ok(saved.content.startsWith("0123456789"));
    assert.match(saved.content, /truncated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SkillStore.list skips corrupt files and load returns null for them", async () => {
  const dir = tmp("proofcast-skills-");
  try {
    const store = new SkillStore({ dir });
    await store.save({ name: "good", content: "ok" });
    writeFileSync(join(dir, "broken.json"), "{ not json", "utf8");
    const list = await store.list();
    assert.deepEqual(list.map((s) => s.name), ["good"], "corrupt file skipped");
    assert.equal(await store.load("broken"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SkillStore.list on a non-existent dir returns []", async () => {
  const store = new SkillStore({ dir: join(tmpdir(), "proofcast-nope-does-not-exist-12345") });
  assert.deepEqual(await store.list(), []);
});

test("normalizeSkillName validates + lower-cases", () => {
  assert.equal(normalizeSkillName("My_Skill-1"), "my_skill-1");
  assert.throws(() => normalizeSkillName("has space"), InvalidSkillNameError);
});

// ── skill tools ────────────────────────────────────────────────────────────────

test("save_skill / list_skills / load_skill / delete_skill drive the store", async () => {
  const dir = tmp("proofcast-skills-");
  try {
    const store = new SkillStore({ dir });
    const registry = new ToolRegistry().registerAll(createSkillTools(store));
    const ctx = { root: "/jail" };

    const saved = await registry.invoke("save_skill", { name: "greet", description: "say hi", content: "print hi" }, ctx);
    assert.equal(saved.ok, true);
    assert.equal(saved.output.name, "greet");

    const listed = await registry.invoke("list_skills", {}, ctx);
    assert.deepEqual(listed.output.skills, [{ name: "greet", description: "say hi" }]);

    const loaded = await registry.invoke("load_skill", { name: "greet" }, ctx);
    assert.equal(loaded.output.content, "print hi");

    const missing = await registry.invoke("load_skill", { name: "ghost" }, ctx);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /No skill named/);

    const deleted = await registry.invoke("delete_skill", { name: "greet" }, ctx);
    assert.deepEqual(deleted.output, { deleted: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save_skill rejects an unsafe name with a structured failure (no throw)", async () => {
  const dir = tmp("proofcast-skills-");
  try {
    const registry = new ToolRegistry().registerAll(createSkillTools(new SkillStore({ dir })));
    const res = await registry.invoke("save_skill", { name: "../escape", content: "x" }, { root: "/j" });
    assert.equal(res.ok, false);
    assert.match(res.error, /Invalid skill name/);
    assert.equal(existsSync(join(dir, "..", "escape.json")), false, "nothing written outside the store dir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save_skill / load_skill validate input", async () => {
  const registry = new ToolRegistry().registerAll(createSkillTools(new SkillStore({ dir: tmp("proofcast-skills-") })));
  assert.equal((await registry.invoke("save_skill", { name: "x" }, { root: "/j" })).ok, false, "no content");
  assert.equal((await registry.invoke("save_skill", { content: "x" }, { root: "/j" })).ok, false, "no name");
  assert.equal((await registry.invoke("load_skill", {}, { root: "/j" })).ok, false, "no name");
});

// ── preference memory + remember_preference ─────────────────────────────────────

test("writePreference persists, de-duplicates, and is readable as a block", () => {
  const home = tmp("proofcast-home-");
  try {
    writePreference("Always deliver the demo as MP4", { homeDir: home });
    writePreference("Never add Claude as a co-author", { homeDir: home });
    writePreference("Always deliver the demo as MP4", { homeDir: home }); // dupe

    const all = readPreferences({ homeDir: home });
    const occurrences = (all.match(/deliver the demo as MP4/g) ?? []).length;
    assert.equal(occurrences, 1, "identical preference is not duplicated");
    assert.match(all, /Never add Claude/);

    const block = readPreferenceBlock(10_000, { homeDir: home });
    assert.match(block, /- Always deliver the demo as MP4/);
    assert.match(block, /- Never add Claude/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writePreference redacts secrets and ignores blanks", () => {
  const home = tmp("proofcast-home-");
  try {
    writePreference("my key is sk-1234567890abcdefghijABCD keep it", { homeDir: home });
    writePreference("   ", { homeDir: home });
    const all = readPreferences({ homeDir: home });
    assert.doesNotMatch(all, /sk-1234567890/, "secret was redacted");
    assert.equal(all.trim().split("\n").length, 1, "blank preference was ignored");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readPreferenceBlock keeps the most recent lines within the char budget", () => {
  const home = tmp("proofcast-home-");
  try {
    for (let i = 0; i < 20; i++) writePreference(`preference number ${i}`, { homeDir: home });
    const block = readPreferenceBlock(60, { homeDir: home });
    assert.ok(block.length <= 60 + 40, "bounded");
    assert.match(block, /preference number 19/, "keeps the newest");
    assert.doesNotMatch(block, /preference number 0\b/, "drops the oldest");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("remember_preference tool persists a preference", async () => {
  const home = tmp("proofcast-home-");
  try {
    const registry = new ToolRegistry().register(createPreferenceTool({ homeDir: home }));
    const res = await registry.invoke("remember_preference", { text: "Prefer TypeScript ESM" }, { root: "/j" });
    assert.equal(res.ok, true);
    assert.equal(res.output.remembered, "Prefer TypeScript ESM");
    assert.match(readPreferences({ homeDir: home }), /Prefer TypeScript ESM/);

    assert.equal((await registry.invoke("remember_preference", {}, { root: "/j" })).ok, false, "validates input");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── runSkill (drives the real runAgent loop) ────────────────────────────────────

test("runSkill loads a saved skill and runs it as an agent goal", async () => {
  const dir = tmp("proofcast-skills-");
  try {
    const store = new SkillStore({ dir });
    await store.save({ name: "cleanup", description: "tidy up", content: "delete temp files then report" });

    let seenGoal;
    const planner = {
      decide: async (goal) => {
        seenGoal = goal;
        return { type: "finish", summary: "cleaned up" };
      },
    };
    const registry = new ToolRegistry().register({
      name: "noop",
      description: "",
      inputSchema: {},
      run: async () => ok(null),
    });

    const result = await runSkill("cleanup", store, planner, registry, { root: "/j" }, { log: () => {} });
    assert.equal(result.success, true);
    assert.equal(result.summary, "cleaned up");
    assert.match(seenGoal, /skill "cleanup"/);
    assert.match(seenGoal, /delete temp files then report/, "skill body became the goal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSkill throws SkillNotFoundError for a missing skill", async () => {
  const store = new SkillStore({ dir: tmp("proofcast-skills-") });
  const planner = { decide: async () => ({ type: "finish", summary: "x" }) };
  const registry = new ToolRegistry();
  await assert.rejects(
    () => runSkill("nope", store, planner, registry, { root: "/j" }, { log: () => {} }),
    SkillNotFoundError,
  );
});
