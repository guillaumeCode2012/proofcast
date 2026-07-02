#!/usr/bin/env node
/**
 * ProofCast one-command setup (run by the AI agent): `npm run setup`.
 *
 * Automates everything that can be automated — install deps, build, install
 * Chromium — then prints a readiness report telling the agent exactly what
 * still needs a human gesture. Non-interactive by design (no prompts).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Run a fixed, trusted command string. `shell: true` with a single string (no
 * args array) is cross-platform and avoids DEP0190; the commands are static
 * literals with no user input, so there is no injection surface.
 */
function run(label, command) {
  console.log(`\n▶ ${label}: ${command}`);
  const result = spawnSync(command, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    console.error(`\n✗ Step failed: ${label}. Fix the error above and re-run \`npm run setup\`.`);
    process.exit(result.status ?? 1);
  }
}

// 1) Dependencies (only if missing — keeps re-runs fast).
if (!existsSync("node_modules")) {
  run("Install dependencies", "npm install");
}

// 2) Build the engine.
run("Build", "npm run build");

// 3) Chromium for the demo recorder (idempotent).
run("Install Chromium (Playwright)", "npx playwright install chromium");

// 4) Readiness report — what's done, what the agent must still do.
const { checkReadiness, formatReadiness } = await import("../dist/setup.js");
console.log(`\n${"=".repeat(60)}\n${formatReadiness(checkReadiness())}\n${"=".repeat(60)}`);
