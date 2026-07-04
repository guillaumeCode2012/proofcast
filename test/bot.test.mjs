import test from "node:test";
import assert from "node:assert/strict";

import {
  DEMO_KEYWORD,
  DEPLOY_KEYWORD,
  DOCKER_INSTALL_URL,
  buildBot,
  createChatState,
  parseDemoText,
  runDemoCommand,
  runDeployCommand,
} from "../dist/bot.js";
import { DirectoryNotFoundError } from "../dist/path-resolver.js";

/** A mock context recording replies (with options) and sent videos. */
function mockCtx(text) {
  const replies = [];
  const replyOptions = [];
  const videos = [];
  return {
    chatId: 1,
    text,
    replies,
    replyOptions,
    videos,
    async reply(t, options) {
      replies.push(t);
      replyOptions.push({ text: t, options });
    },
    async replyWithVideo(video, extra) {
      videos.push({ video, extra });
    },
  };
}

/** Injectable deps that record calls; never touch the network / real services. */
function mockDeps({
  demoThrows = false,
  deployThrows = false,
  dockerAvailable = true,
  healResult,
  resolveResult,
  resolveThrows,
} = {}) {
  const calls = {
    generateFeature: 0,
    recordDemo: 0,
    deployWithVercel: 0,
    isDockerAvailable: 0,
    resolveAnyDirectory: null,
    executeAndHeal: null,
    lastDescription: null,
    logs: [],
    memoryWrites: [],
  };
  return {
    calls,
    async generateFeature(description) {
      calls.generateFeature++;
      calls.lastDescription = description;
      return "<html><body>feature</body></html>";
    },
    async recordDemo(recordOptions) {
      calls.recordDemo++;
      calls.lastRecordOptions = recordOptions;
      if (demoThrows) throw new Error("recording blew up");
      return {
        video: Buffer.from("FAKE-MP4-BYTES"),
        videoPath: "/tmp/x.mp4",
        webmPath: "/tmp/x.webm",
        sizeBytes: 14,
      };
    },
    deployWithVercel() {
      calls.deployWithVercel++;
      if (deployThrows) throw new Error("build failed");
      return { url: "https://proj-acme.vercel.app", rawOutput: "Production: https://proj-acme.vercel.app" };
    },
    async resolveAnyDirectory(hint) {
      calls.resolveAnyDirectory = hint;
      if (resolveThrows) throw resolveThrows;
      return resolveResult !== undefined ? resolveResult : "/resolved/project";
    },
    isDockerAvailable() {
      calls.isDockerAvailable++;
      return dockerAvailable;
    },
    async executeAndHeal(description, dir, maxRetries, options) {
      calls.executeAndHeal = { description, dir, maxRetries, options };
      return healResult ?? { video: Buffer.from("HEAL-MP4"), success: true, attempts: 2 };
    },
    // In-memory stand-ins so tests never touch proofcast-live.md / ~/.proofcast.
    logLiveContext(step, details) {
      calls.logs.push({ step, details });
    },
    writeMemory(entry) {
      calls.memoryWrites.push(entry);
    },
  };
}

test("keyword regexes match the right commands and don't overlap", () => {
  assert.ok(DEMO_KEYWORD.test("Démo"));
  assert.ok(DEMO_KEYWORD.test("démo: une page de login"));
  assert.ok(!DEMO_KEYWORD.test("Déploie"));
  assert.ok(DEPLOY_KEYWORD.test("Déploie"));
  assert.ok(DEPLOY_KEYWORD.test("Deploie maintenant"));
  assert.ok(!DEPLOY_KEYWORD.test("Démo"));
});

test("PROOFCAST rule: 'Déploie' is blocked without a prior demo", async () => {
  const state = createChatState();
  const ctx = mockCtx("Déploie");
  const deps = mockDeps();

  await runDeployCommand(ctx, state, deps);

  assert.equal(deps.calls.deployWithVercel, 0, "must NOT deploy without a demo");
  assert.match(ctx.replies.join("\n"), /Démo/, "should tell the user to run Démo first");
});

test("'Démo' generates a feature, records the proof, sends the MP4, marks demo-ready", async () => {
  const state = createChatState();
  const ctx = mockCtx("Démo une page de connexion");
  const deps = mockDeps();

  await runDemoCommand(ctx, state, deps);

  assert.equal(deps.calls.generateFeature, 1);
  assert.equal(deps.calls.recordDemo, 1);
  assert.equal(deps.calls.lastDescription, "une page de connexion");
  assert.equal(ctx.videos.length, 1, "should send exactly one video");
  assert.ok(Buffer.isBuffer(ctx.videos[0].video.source), "video payload is a Buffer");
  assert.ok(ctx.videos[0].video.filename.endsWith(".mp4"));
  assert.equal(state.demoReady, true);
  assert.ok(deps.calls.logs.length >= 3, "should log live context around heavy actions");
});

test("'Démo' strips markdown fences from AI output before recording", async () => {
  const state = createChatState();
  const deps = mockDeps();
  deps.generateFeature = async () =>
    "```html\n<!doctype html><html><body>ok</body></html>\n```";

  await runDemoCommand(mockCtx("Démo"), state, deps);

  const html = deps.calls.lastRecordOptions.html;
  assert.ok(!html.includes("```"), "fences must be stripped before recordDemo");
  assert.ok(html.startsWith("<!doctype html>"), "a servable HTML document is passed");
});

test("'Démo' with no description falls back to a default description", async () => {
  const state = createChatState();
  const deps = mockDeps();
  await runDemoCommand(mockCtx("Démo"), state, deps);
  assert.equal(deps.calls.generateFeature, 1);
  assert.ok(deps.calls.lastDescription.length > 0, "should use a non-empty default description");
});

test("'Démo' then 'Déploie' succeeds and returns the URL", async () => {
  const state = createChatState();
  const deps = mockDeps();

  await runDemoCommand(mockCtx("Démo"), state, deps);
  const deployCtx = mockCtx("Déploie");
  await runDeployCommand(deployCtx, state, deps);

  assert.equal(deps.calls.deployWithVercel, 1);
  assert.match(deployCtx.replies.join("\n"), /vercel\.app/, "should report the deployment URL");
});

test("a failing demo is reported, does not crash, and leaves deploy blocked", async () => {
  const state = createChatState();
  const deps = mockDeps({ demoThrows: true });
  const ctx = mockCtx("Démo x");

  // Must not throw — the bot survives handler failures.
  await runDemoCommand(ctx, state, deps);

  assert.equal(state.demoReady, false, "a failed demo must not mark demo-ready");
  assert.match(ctx.replies.join("\n"), /Échec/, "should report the failure");
  assert.equal(deps.calls.memoryWrites.length, 1, "a fatal failure is written to memory");

  // And deployment stays blocked.
  const deployCtx = mockCtx("Déploie");
  await runDeployCommand(deployCtx, state, deps);
  assert.equal(deps.calls.deployWithVercel, 0);
});

test("a failing deployment is reported without throwing", async () => {
  const state = createChatState();
  const deps = mockDeps({ deployThrows: true });
  await runDemoCommand(mockCtx("Démo"), state, deps);

  const ctx = mockCtx("Déploie");
  await runDeployCommand(ctx, state, deps); // must not throw
  assert.match(ctx.replies.join("\n"), /Échec du déploiement/);
});

test("buildBot wires a Telegraf instance without launching (fake token)", () => {
  const bot = buildBot("123456789:AAExampleExampleExampleExampleExampl");
  assert.equal(typeof bot.launch, "function");
  assert.equal(typeof bot.stop, "function");
  assert.equal(typeof bot.hears, "function");
});

test("parseDemoText splits an optional target folder from the description", () => {
  assert.deepEqual(parseDemoText("Démo a login page"), {
    folderHint: null,
    description: "a login page",
  });
  assert.deepEqual(parseDemoText("Démo /path/to/app | add a reset button"), {
    folderHint: "/path/to/app",
    description: "add a reset button",
  });
  // A Windows path keeps its drive `:` — only the pipe splits.
  assert.deepEqual(parseDemoText("Démo C:\\Users\\me\\app | do X"), {
    folderHint: "C:\\Users\\me\\app",
    description: "do X",
  });
  assert.deepEqual(parseDemoText("Démo ./app | add a button"), {
    folderHint: "./app",
    description: "add a button",
  });
  // A stray pipe in a plain description must NOT be mistaken for a folder.
  assert.deepEqual(parseDemoText("Démo a page with A | B options"), {
    folderHint: null,
    description: "a page with A | B options",
  });
});

test("'Démo <folder> | …' runs brownfield self-heal in the Docker sandbox and sends the healed video", async () => {
  const state = createChatState();
  const ctx = mockCtx("Démo /path/to/app | ajoute un bouton reset");
  const deps = mockDeps({ dockerAvailable: true });

  await runDemoCommand(ctx, state, deps);

  assert.equal(deps.calls.resolveAnyDirectory, "/path/to/app", "resolves the given folder");
  assert.equal(deps.calls.recordDemo, 0, "brownfield does not use the greenfield recorder");
  assert.ok(deps.calls.executeAndHeal, "runs executeAndHeal");
  assert.equal(deps.calls.executeAndHeal.description, "ajoute un bouton reset");
  assert.equal(deps.calls.executeAndHeal.dir, "/resolved/project");
  assert.equal(deps.calls.executeAndHeal.options.execution, "docker", "uses the sandbox");
  assert.equal(ctx.videos.length, 1, "sends the healed proof video");
  assert.equal(ctx.videos[0].video.source.toString(), "HEAL-MP4");
  assert.equal(state.demoReady, true);
});

test("'Démo <folder> | …' with no Docker warns, offers an install button, and falls back to local", async () => {
  const state = createChatState();
  const ctx = mockCtx("Démo /path/to/app | fais un truc");
  const deps = mockDeps({ dockerAvailable: false });

  await runDemoCommand(ctx, state, deps);

  const warning = ctx.replyOptions.find((r) => /Docker non détecté/.test(r.text));
  assert.ok(warning, "warns that Docker was not detected");
  assert.ok(warning.options?.buttonUrl, "offers a button");
  assert.equal(warning.options.buttonUrl.url, DOCKER_INSTALL_URL);
  assert.match(warning.options.buttonUrl.text, /Installer Docker/);

  assert.equal(deps.calls.executeAndHeal.options.execution, "local", "falls back to local execution");
  assert.equal(state.demoReady, true);
  assert.equal(ctx.videos.length, 1);
});

test("'Démo' without a folder stays greenfield (unchanged) and never touches the heal path", async () => {
  const state = createChatState();
  const deps = mockDeps();
  await runDemoCommand(mockCtx("Démo une page de connexion"), state, deps);

  assert.equal(deps.calls.recordDemo, 1, "greenfield recorder used");
  assert.equal(deps.calls.executeAndHeal, null, "no brownfield heal");
  assert.equal(deps.calls.resolveAnyDirectory, null, "no folder resolution");
});

test("brownfield: a heal failure is reported and leaves deploy blocked", async () => {
  const state = createChatState();
  const ctx = mockCtx("Démo /path/to/app | build it");
  const deps = mockDeps({
    healResult: { video: Buffer.alloc(0), success: false, attempts: 3, lastError: "TypeError boom" },
  });

  await runDemoCommand(ctx, state, deps);

  assert.equal(state.demoReady, false, "a failed heal must not mark demo-ready");
  assert.equal(ctx.videos.length, 0, "no video on failure");
  assert.match(ctx.replies.join("\n"), /3 tentative|TypeError boom/i);
});

test("brownfield: an unknown folder yields a friendly error, no crash, deploy stays blocked", async () => {
  const state = createChatState();
  const ctx = mockCtx("Démo /nope | build it");
  const deps = mockDeps({ resolveThrows: new DirectoryNotFoundError("/nope") });

  await runDemoCommand(ctx, state, deps); // must not throw

  assert.match(ctx.replies.join("\n"), /introuvable/i);
  assert.equal(deps.calls.executeAndHeal, null, "never runs the heal without a directory");
  assert.equal(state.demoReady, false);
});
