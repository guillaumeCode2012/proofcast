import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CONFIG_FILENAME,
  generateBotFatherLink,
  loadToken,
  saveToken,
} from "../dist/onboarding.js";
import {
  buildBot,
  createChatState,
  runDemoCommand,
  runDeployCommand,
} from "../dist/bot.js";

/** A syntactically valid (fake) Telegram token. */
const VALID_TOKEN = `123456789:${"A".repeat(35)}`;

function tempProject() {
  return mkdtempSync(join(tmpdir(), "proofcast-e2e-"));
}

function mockCtx(text) {
  const replies = [];
  const videos = [];
  return {
    chatId: 42,
    text,
    replies,
    videos,
    async reply(t) {
      replies.push(t);
    },
    async replyWithVideo(video, extra) {
      videos.push({ video, extra });
    },
  };
}

/** Mocks the three heavy modules (ai / video / deployer) behind the bot. */
function mockDeps() {
  const calls = { generateFeature: 0, recordDemo: 0, deployWithVercel: 0 };
  return {
    calls,
    async generateFeature(description) {
      calls.generateFeature++;
      return `<html><body><!-- ${description} --></body></html>`;
    },
    async recordDemo() {
      calls.recordDemo++;
      return {
        video: Buffer.from("FAKE-MP4"),
        videoPath: "/tmp/demo.mp4",
        webmPath: "/tmp/demo.webm",
        sizeBytes: 8,
      };
    },
    deployWithVercel() {
      calls.deployWithVercel++;
      return { url: "https://acme.vercel.app", rawOutput: "Production: https://acme.vercel.app" };
    },
    // No-op logging so the end-to-end test never writes proofcast-live.md / ~/.proofcast.
    logLiveContext() {},
    writeMemory() {},
  };
}

test("end-to-end (mocked): onboarding → token → bot → démo → déploiement", async () => {
  const root = tempProject();
  try {
    // 1) Onboarding: magic link + persist the validated token.
    const link = generateBotFatherLink("AcmeBot");
    assert.ok(link.startsWith("https://t.me/BotFather"), "magic link points at BotFather");

    saveToken(VALID_TOKEN, root);
    assert.ok(existsSync(join(root, CONFIG_FILENAME)), "config written");
    assert.equal(loadToken(root), VALID_TOKEN, "token round-trips");

    // 2) "Start" the bot: wire it with the saved token (no network launch).
    const wired = buildBot(loadToken(root), mockDeps());
    assert.equal(typeof wired.launch, "function", "bot is wired");

    // 3) Drive a chat session through the real handlers with mocked heavy deps.
    const deps = mockDeps();
    const state = createChatState();

    // ProofCast rule: deploy is blocked before any demo.
    const deploy1 = mockCtx("Déploie");
    await runDeployCommand(deploy1, state, deps);
    assert.equal(deps.calls.deployWithVercel, 0, "no deploy before a demo");
    assert.match(deploy1.replies.join("\n"), /Démo/);

    // Démo: feature generated → proof recorded → MP4 sent → demo-ready.
    const demo = mockCtx("Démo une landing page");
    await runDemoCommand(demo, state, deps);
    assert.equal(deps.calls.generateFeature, 1);
    assert.equal(deps.calls.recordDemo, 1);
    assert.equal(demo.videos.length, 1, "MP4 sent to the user");
    assert.ok(demo.videos[0].video.filename.endsWith(".mp4"));
    assert.equal(state.demoReady, true);

    // Déploie: now allowed → returns the production URL.
    const deploy2 = mockCtx("Déploie");
    await runDeployCommand(deploy2, state, deps);
    assert.equal(deps.calls.deployWithVercel, 1);
    assert.match(deploy2.replies.join("\n"), /vercel\.app/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("end-to-end: config file and .gitignore protection are created by onboarding", () => {
  const root = tempProject();
  try {
    saveToken(VALID_TOKEN, root);
    // The secret store exists and is git-ignored.
    assert.ok(existsSync(join(root, CONFIG_FILENAME)));
    const gitignore = join(root, ".gitignore");
    assert.ok(existsSync(gitignore));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
