import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

// Load real credentials from a git-ignored .env if present (no-op otherwise).
try {
  if (existsSync(".env")) process.loadEnvFile(".env");
} catch {
  /* ignore malformed/missing .env */
}

import { generateFeature } from "../dist/ai.js";
import { recordDemo } from "../dist/video.js";
import { deployWithVercel, isVercelInstalled } from "../dist/deployer.js";
import { buildBot } from "../dist/bot.js";

const LIVE = process.env.PROOFCAST_LIVE === "1";

const aiReady =
  LIVE &&
  ((process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL) ||
    (process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL) ||
    !!process.env.PROOFCAST_AI_PROVIDER);

const telegramReady =
  aiReady && !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID;

const deployReady =
  LIVE && process.env.PROOFCAST_LIVE_DEPLOY === "1" && isVercelInstalled();

test(
  "LIVE: generateFeature returns real HTML from the configured provider",
  { skip: !aiReady && "set PROOFCAST_LIVE=1 + a provider key/model in .env" },
  async () => {
    const html = await generateFeature(
      "a simple landing page with a heading and a call-to-action button",
    );
    assert.ok(html.trim().length > 0, "model should return non-empty output");
  },
);

test(
  "LIVE: full Démo pipeline generates, records, and sends a real MP4 to Telegram",
  { skip: !telegramReady && "set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env" },
  async () => {
    const html = await generateFeature("a landing page with a hero section");
    const demo = await recordDemo({ html });
    assert.ok(demo.sizeBytes > 0);

    const bot = buildBot(process.env.TELEGRAM_BOT_TOKEN);
    await bot.telegram.sendVideo(
      process.env.TELEGRAM_CHAT_ID,
      { source: demo.video, filename: "proofcast-demo.mp4" },
      { caption: "ProofCast — live pipeline test ✅" },
    );
  },
);

test(
  "LIVE: deployWithVercel deploys the current project (DESTRUCTIVE)",
  { skip: !deployReady && "set PROOFCAST_LIVE_DEPLOY=1 (needs `vercel login`)" },
  async () => {
    const result = deployWithVercel({
      cwd: process.env.PROOFCAST_DEPLOY_CWD || process.cwd(),
    });
    assert.match(result.url, /^https:\/\//, "should return a production URL");
  },
);
