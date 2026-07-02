import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const AGENTS = readFileSync("AGENTS.md", "utf8");
const CLAUDE = readFileSync("CLAUDE.md", "utf8");

test("AGENTS.md is a zero-friction runbook with the critical rules", () => {
  assert.match(AGENTS, /npm run setup/, "one-command setup");
  assert.match(AGENTS, /only.{0,20}bot name/i, "asks only for the bot name");
  assert.match(AGENTS, /Never ask the user for a file path/i, "never asks for a path");
  assert.match(AGENTS, /Never ask for the Telegram token in the terminal/i);
  assert.match(AGENTS, /\bWAIT\b/, "waits for the user on Vercel login");
  assert.match(AGENTS, /j.ai terminé la connexion/, "the Vercel confirmation phrase");
  assert.match(AGENTS, /Never poll/i, "no infinite polling");
  assert.match(AGENTS, /blocked until a « Démo »/i, "the ProofCast rule");
});

test("CLAUDE.md redirects to AGENTS.md and keeps the essentials", () => {
  assert.match(CLAUDE, /AGENTS\.md/);
  assert.match(CLAUDE, /npm run setup/);
  assert.match(CLAUDE, /bot name/i);
  assert.match(CLAUDE, /WAIT/);
});
