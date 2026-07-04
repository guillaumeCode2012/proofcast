import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * "Read the README as if you were the agent" — encoded as assertions so the
 * mandatory, unambiguous instructions can never silently disappear.
 */
const README = readFileSync("README.md", "utf8");

function requires(label, pattern) {
  assert.match(README, pattern, `README must state: ${label}`);
}

test("README states the proof-before-deploy positioning", () => {
  requires("proof-before-deploy differentiator", /proof before deploy/i);
  requires("Déploie blocked until Démo", /blocked until a `?Démo/i);
});

test("README: the agent asks for exactly ONE thing — the bot name", () => {
  requires("only the bot name is asked", /exactly ONE thing: the bot name/i);
  requires("never ask token in terminal", /NEVER ask for the Telegram token in the terminal/i);
  requires("never re-request the provider key", /NEVER ask for \(or re-request\) the AI provider API key/i);
});

test("README: Vercel login is stop-and-wait, never polling", () => {
  requires("runs vercel login", /vercel login/);
  requires("explicit WAIT", /\bWAIT\b/);
  requires("waits for explicit user confirmation", /j.ai terminé la connexion/);
  requires("no infinite polling", /poll/i);
  requires("agent cannot complete the OAuth flow", /cannot complete (a|this) browser OAuth flow/i);
});

test("README NAVIGATION: never ask for an absolute path", () => {
  requires("NAVIGATION section", /## NAVIGATION/);
  requires("never ask for an absolute path", /NEVER ask the user for an absolute path/i);
  requires("uses the path resolver", /resolveTargetDirectory/);
  requires("stays inside the project", /stays inside the project/i);
});

test("README TRANSPARENCE & DEBUG: where to look on a crash", () => {
  requires("live context file", /proofcast-live\.md/);
  requires("the crash phrase", /lis le contexte de proofcast/i);
  requires("how to read it", /getSessionContext/);
});

test("README APPRENTISSAGE: project-scoped memory, never delete", () => {
  requires("project-scoped memory path", /~\/\.proofcast\/memory/);
  requires("never delete between sessions", /Never delete this file between sessions/i);
});

test("README AI CONFIG: documents the dual-mode contract (both branches)", () => {
  requires("dual-mode config section", /AI configuration/i);
  requires("aiMode key", /aiMode/);
  requires("API branch", /API_KEY/);
  requires("Subscription branch", /AGENT_SUBSCRIPTION/);
  requires("written to the config file", /\.proofcast-config\.json/);
  requires("asks the user which mode", /clé API Anthropic.*abonnement/is);
});

test("README AI CONFIG: documents EXACTLY the implemented commands (run + generate)", () => {
  // These must match what 13.1–13.3 actually shipped.
  requires("run command with dirPath", /proofcast run <dirPath>/);
  requires("generate command with description + dirPath", /proofcast generate "<description>" <dirPath>/);
  // …and must NOT resurrect a command that no longer exists.
  assert.doesNotMatch(README, /proofcast resume/i, "no phantom 'resume' command");
});

test("README AI CONFIG: subscription = no AI call (agent owns repair); API = self-heal up to 3", () => {
  requires("subscription makes no LLM call", /no LLM call/i);
  requires("the agent owns the fix loop", /all code repair is your responsibility/i);
  requires("run reports the proof path", /proofPath/);
  requires("run failure tells the agent to fix the files", /fix the affected files/i);
  requires("API mode self-repairs up to 3 attempts", /up to 3 attempts/i);
  requires("exit code + JSON contract", /exit code/i);
});

test("README: no trace of the abandoned file-handoff / exchange-file mechanism", () => {
  assert.doesNotMatch(
    README,
    /handoff file|handoff par fichier|exchange file|fichier d'échange|\bresume\b/i,
    "the file-handoff mechanism and the resume command were abandoned in favor of the CLI contract",
  );
});
