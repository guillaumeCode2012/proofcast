import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  analyzeTargetDirectory,
  ANALYSIS_ERROR_PREFIX,
  truncateSource,
} from "../dist/context-analyzer.js";
import {
  BROWNFIELD_SYSTEM_PROMPT,
  InvalidBrownfieldResponseError,
  generateFeature,
  parseBrownfieldResponse,
} from "../dist/ai.js";

/** A pluggable fake provider that records its calls and returns a canned reply. */
function fakeProvider(reply = "[]") {
  const calls = [];
  return {
    calls,
    name: "fake",
    async generateFeature(description, options) {
      calls.push({ description, options });
      return reply;
    },
  };
}

function makeTempDir(prefix = "proofcast-ctx-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("analyzeTargetDirectory returns Structure + Code and reads key files", async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "page.tsx"), "export function Page() { return <div>Bonjour</div>; }\n");
    writeFileSync(join(dir, "package.json"), '{ "name": "demo" }\n');

    const out = await analyzeTargetDirectory(dir);

    assert.ok(!out.startsWith(ANALYSIS_ERROR_PREFIX), "not an error");
    assert.match(out, /## Structure/);
    assert.match(out, /## Code/);
    assert.match(out, /page\.tsx/);
    assert.match(out, /Bonjour/, "reads source content");
    assert.match(out, /"name": "demo"/, "reads package.json content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analyzeTargetDirectory excludes node_modules and dot-directories", async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "page.tsx"), "export const KEEP_ME = 1;\n");
    mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "left-pad", "junkModule.js"), "export const DROP_NM = 1;\n");
    mkdirSync(join(dir, ".hidden"), { recursive: true });
    writeFileSync(join(dir, ".hidden", "secretFile.ts"), "export const DROP_DOT = 1;\n");

    const out = await analyzeTargetDirectory(dir);

    assert.match(out, /KEEP_ME/, "keeps normal source");
    assert.doesNotMatch(out, /junkModule|DROP_NM/, "excludes node_modules");
    assert.doesNotMatch(out, /secretFile|DROP_DOT/, "excludes dot-directories");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analyzeTargetDirectory returns an explicit error for a missing path (no crash)", async () => {
  const missing = join(tmpdir(), "proofcast-does-not-exist-" + Date.now());
  const out = await analyzeTargetDirectory(missing);
  assert.ok(out.startsWith(ANALYSIS_ERROR_PREFIX), "prefixed error string");
  assert.match(out, /introuvable|inaccessible/);
});

test("analyzeTargetDirectory returns an explicit error for blank input", async () => {
  const out = await analyzeTargetDirectory("   ");
  assert.ok(out.startsWith(ANALYSIS_ERROR_PREFIX));
});

test("analyzeTargetDirectory returns an explicit error for an empty directory", async () => {
  const dir = makeTempDir();
  try {
    const out = await analyzeTargetDirectory(dir);
    assert.ok(out.startsWith(ANALYSIS_ERROR_PREFIX));
    assert.match(out, /vide/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analyzeTargetDirectory truncates long function bodies past the char cap", async () => {
  const dir = makeTempDir();
  try {
    // Entry file: small, must survive intact.
    writeFileSync(join(dir, "index.ts"), "export const ENTRY_UNIQUE_MARKER = 12345;\n");

    // Many large files (>100k total) with long function bodies.
    const bodyLine = "  const padded = compute(value) + 000000000000000000000000000; // filler";
    let rawTotal = "export const ENTRY_UNIQUE_MARKER = 12345;\n".length;
    for (let i = 0; i < 40; i++) {
      const body = Array.from({ length: 50 }, () => bodyLine).join("\n");
      const src = `import { compute } from "./util";\n\nexport function feature${i}(value: number): number {\n${body}\n  return value;\n}\n`;
      rawTotal += src.length;
      writeFileSync(join(dir, `f${i}.ts`), src);
    }
    assert.ok(rawTotal > 100_000, `test fixture must exceed the cap (was ${rawTotal})`);

    const out = await analyzeTargetDirectory(dir);

    assert.ok(!out.startsWith(ANALYSIS_ERROR_PREFIX), "not an error");
    assert.match(out, /corps tronqué, \d+ lignes/, "inserts the truncation marker");
    assert.match(out, /ENTRY_UNIQUE_MARKER = 12345/, "entry file kept complete");
    assert.match(out, /export function feature0\(/, "signatures preserved");
    assert.ok(out.length < rawTotal, `output (${out.length}) smaller than raw (${rawTotal})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("truncateSource keeps signatures/types and collapses only long bodies", () => {
  const src = [
    "import { x } from './x';",
    "export interface Config {",
    "  a: number;",
    "  b: string;",
    "  c: boolean;",
    "  d: number;",
    "  e: string;",
    "}",
    "export function doWork(n: number): number {",
    "  let total = 0;",
    "  total += 1;",
    "  total += 2;",
    "  total += 3;",
    "  total += 4;",
    "  total += 5;",
    "  return total;",
    "}",
  ].join("\n");

  const out = truncateSource(src);
  assert.match(out, /import \{ x \} from '\.\/x';/, "keeps imports");
  assert.match(out, /export interface Config \{[\s\S]*e: string;/, "keeps the whole interface");
  assert.match(out, /export function doWork\(n: number\): number \{/, "keeps the function signature");
  assert.match(out, /corps tronqué, \d+ lignes/, "collapses the long body");
  assert.doesNotMatch(out, /total \+= 3;/, "body lines are removed");
});

test("generateFeature (brownfield) injects the project + brownfield contract; response targets the existing file", async () => {
  const dir = makeTempDir();
  try {
    // An EXISTING page with a form but no reset button.
    writeFileSync(
      join(dir, "page.tsx"),
      "export function Page() {\n  return <form><input name=\"email\" /></form>;\n}\n",
    );

    // The model (mocked) chooses to MODIFY the existing file, not create a new one.
    const modelReply = JSON.stringify([
      {
        path: "page.tsx",
        action: "modify",
        content:
          "export function Page() {\n  return <form><input name=\"email\" /><button type=\"reset\">Réinitialiser</button></form>;\n}\n",
      },
    ]);
    const provider = fakeProvider(modelReply);

    const raw = await generateFeature("ajoute un bouton pour réinitialiser le formulaire", {
      provider,
      targetDir: dir,
      memory: false,
    });

    // Plumbing: the existing project + brownfield contract reached the provider.
    assert.equal(provider.calls.length, 1);
    const call = provider.calls[0];
    assert.match(call.options.system, /BROWNFIELD/, "brownfield system prompt used");
    assert.match(call.description, /## Structure/, "project structure injected");
    assert.match(call.description, /page\.tsx/, "existing file surfaced to the model");
    assert.match(call.description, /Requested change/, "the ask is included");

    // Contract: response targets the existing file as a modify, no redundant create.
    const changes = parseBrownfieldResponse(raw);
    assert.equal(changes.length, 1, "exactly one file changed");
    assert.equal(changes[0].path, "page.tsx");
    assert.equal(changes[0].action, "modify", "modifies rather than creates");
    assert.match(changes[0].content, /type="reset"/, "the button was added");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generateFeature greenfield path is unchanged (no targetDir → raw description)", async () => {
  const provider = fakeProvider("<html>ok</html>");
  const out = await generateFeature("a login page", { provider, memory: false });
  assert.equal(out, "<html>ok</html>");
  assert.equal(provider.calls[0].description, "a login page", "no project context injected");
});

test("parseBrownfieldResponse tolerates a ```json fence and validates the shape", () => {
  const fenced = '```json\n[{"path":"a.ts","action":"create","content":"x"}]\n```';
  const changes = parseBrownfieldResponse(fenced);
  assert.deepEqual(changes, [{ path: "a.ts", action: "create", content: "x" }]);
});

test("parseBrownfieldResponse rejects invalid payloads", () => {
  assert.throws(() => parseBrownfieldResponse(""), InvalidBrownfieldResponseError);
  assert.throws(() => parseBrownfieldResponse("not json at all"), InvalidBrownfieldResponseError);
  assert.throws(() => parseBrownfieldResponse('{"path":"a"}'), InvalidBrownfieldResponseError);
  assert.throws(
    () => parseBrownfieldResponse('[{"path":"a.ts","action":"delete","content":"x"}]'),
    InvalidBrownfieldResponseError,
  );
  assert.throws(
    () => parseBrownfieldResponse('[{"path":"a.ts","action":"modify"}]'),
    InvalidBrownfieldResponseError,
  );
});
