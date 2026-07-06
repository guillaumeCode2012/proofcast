/**
 * ProofCast — proof-before-deploy engine for AI agents.
 *
 * This is the public entry point. It is meant to be driven by an AI coding
 * agent (Claude Code, Codex, Cursor), not by a human at a terminal.
 *
 * Core promise: the agent builds a feature, produces a VIDEO PROOF (a recorded
 * demo), and only deploys after the user has implicitly validated that proof.
 *
 * Modules are wired in during subsequent build steps:
 *   - onboarding (src/onboarding.ts) — bot naming + token persistence
 *   - ai         (src/ai.ts)         — feature generation via Claude
 *   - video      (src/video.ts)      — Playwright demo recording
 *   - deployer   (src/deployer.ts)   — Vercel deployment
 *   - bot        (src/bot.ts)        — Telegram control surface (Démo / Déploie)
 */

export const PROOFCAST_VERSION = "0.1.0";

export * from "./onboarding.js";
export * from "./config.js";
export * from "./ai.js";
export * from "./context-analyzer.js";
export * from "./orchestrator.js";
export * from "./prover.js";
export * from "./sandbox.js";
export * from "./video.js";
export * from "./deployer.js";
export * from "./bot.js";
export * from "./path-resolver.js";
export * from "./memory.js";
export * from "./tools/index.js";
export * from "./agent.js";
export * from "./planner.js";
export * from "./setup.js";
