import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeMemory } from "../dist/memory.js";
import {
  EmptyFeatureResponseError,
  MissingApiKeyError,
  MissingModelError,
  NoProviderConfiguredError,
  UnknownProviderError,
  createAnthropicProvider,
  createOpenAiProvider,
  extractHtmlDocument,
  generateFeature,
  resolveProvider,
} from "../dist/ai.js";

/** A pluggable fake provider that records its calls. */
function fakeProvider() {
  const calls = [];
  return {
    calls,
    name: "fake",
    async generateFeature(description, options) {
      calls.push({ description, options });
      return "GENERATED-HTML";
    },
  };
}

/** Mock Anthropic SDK client. */
function mockAnthropic(response) {
  const calls = [];
  return { calls, messages: { create: async (p) => (calls.push(p), response) } };
}

/** Mock OpenAI SDK client. */
function mockOpenAi(response) {
  const calls = [];
  return { calls, chat: { completions: { create: async (p) => (calls.push(p), response) } } };
}

test("generateFeature delegates to the injected provider and forwards options", async () => {
  const provider = fakeProvider();
  const out = await generateFeature("a login page", {
    provider,
    model: "m1",
    maxTokens: 123,
    system: "SYS",
    memory: false, // deterministic: no memory injection
  });
  assert.equal(out, "GENERATED-HTML");
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].description, "a login page");
  assert.deepEqual(provider.calls[0].options, { model: "m1", maxTokens: 123, system: "SYS" });
});

test("generateFeature rejects a blank description before touching a provider", async () => {
  const provider = fakeProvider();
  await assert.rejects(() => generateFeature("   ", { provider }), TypeError);
  assert.equal(provider.calls.length, 0);
});

test("resolveProvider maps names, passes instances, rejects unknown", () => {
  assert.equal(resolveProvider("anthropic").name, "anthropic");
  assert.equal(resolveProvider("openai").name, "openai");
  const provider = fakeProvider();
  assert.equal(resolveProvider(provider), provider);
  assert.throws(() => resolveProvider("gemini"), UnknownProviderError);
});

test("resolveProvider auto-detects from API keys and errors when none present", () => {
  const saved = {
    provider: process.env.PROOFCAST_AI_PROVIDER,
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };
  delete process.env.PROOFCAST_AI_PROVIDER;
  try {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    delete process.env.OPENAI_API_KEY;
    assert.equal(resolveProvider().name, "anthropic");

    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-test";
    assert.equal(resolveProvider().name, "openai");

    delete process.env.OPENAI_API_KEY;
    assert.throws(() => resolveProvider(), NoProviderConfiguredError);
  } finally {
    restoreEnv("PROOFCAST_AI_PROVIDER", saved.provider);
    restoreEnv("ANTHROPIC_API_KEY", saved.anthropic);
    restoreEnv("OPENAI_API_KEY", saved.openai);
  }
});

test("anthropic provider builds the request and returns the text block", async () => {
  const client = mockAnthropic({
    stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "" }, { type: "text", text: "<html>ok</html>" }],
  });
  const provider = createAnthropicProvider({ client, model: "claude-x" });
  const out = await provider.generateFeature("login page", { maxTokens: 999 });

  assert.equal(out, "<html>ok</html>");
  const req = client.calls[0];
  assert.equal(req.model, "claude-x");
  assert.equal(req.max_tokens, 999);
  assert.equal(req.messages[0].content, "login page");
});

test("anthropic provider throws MissingModelError without a model", async () => {
  const saved = process.env.ANTHROPIC_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  try {
    const provider = createAnthropicProvider({ client: mockAnthropic({}) });
    await assert.rejects(() => provider.generateFeature("x"), MissingModelError);
  } finally {
    restoreEnv("ANTHROPIC_MODEL", saved);
  }
});

test("anthropic provider throws MissingApiKeyError without a client or key", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const provider = createAnthropicProvider({ model: "claude-x" });
    await assert.rejects(() => provider.generateFeature("x"), MissingApiKeyError);
  } finally {
    restoreEnv("ANTHROPIC_API_KEY", saved);
  }
});

test("anthropic provider throws on a refusal", async () => {
  const provider = createAnthropicProvider({
    client: mockAnthropic({ stop_reason: "refusal", content: [] }),
    model: "claude-x",
  });
  await assert.rejects(() => provider.generateFeature("x"), EmptyFeatureResponseError);
});

test("openai provider builds the chat request and returns the message content", async () => {
  const client = mockOpenAi({
    choices: [{ message: { content: "<html>oi</html>" }, finish_reason: "stop" }],
  });
  const provider = createOpenAiProvider({ client, model: "gpt-x" });
  const out = await provider.generateFeature("login page", { maxTokens: 777, system: "SYS" });

  assert.equal(out, "<html>oi</html>");
  const req = client.calls[0];
  assert.equal(req.model, "gpt-x");
  assert.equal(req.max_tokens, 777);
  assert.equal(req.messages[0].role, "system");
  assert.equal(req.messages[0].content, "SYS");
  assert.equal(req.messages[1].role, "user");
  assert.equal(req.messages[1].content, "login page");
});

test("openai provider throws when the content is empty", async () => {
  const provider = createOpenAiProvider({
    client: mockOpenAi({ choices: [{ message: { content: "" }, finish_reason: "length" }] }),
    model: "gpt-x",
  });
  await assert.rejects(() => provider.generateFeature("x"), EmptyFeatureResponseError);
});

test("generateFeature injects the last memory lines into the system prompt", async () => {
  const home = mkdtempSync(join(tmpdir(), "proofcast-ai-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "proofcast-ai-proj-"));
  try {
    writeMemory("previously: the user prefers a dark theme", { cwd, homeDir: home });

    const provider = fakeProvider();
    await generateFeature("a settings page", {
      provider,
      system: "BASE-PROMPT",
      memory: { cwd, homeDir: home },
    });

    const system = provider.calls[0].options.system;
    assert.ok(system.startsWith("BASE-PROMPT"), "keeps the base system prompt");
    assert.match(system, /Recent ProofCast context/);
    assert.match(system, /dark theme/, "injects recent memory into the prompt");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("extractHtmlDocument strips markdown fences and isolates the document", () => {
  const fenced = "Sure, here it is:\n```html\n<!doctype html><html><body>hi</body></html>\n```\nEnjoy!";
  assert.equal(extractHtmlDocument(fenced), "<!doctype html><html><body>hi</body></html>");

  const plain = "<!doctype html><html><body>x</body></html>";
  assert.equal(extractHtmlDocument(plain), plain);

  assert.equal(extractHtmlDocument("<div>just a fragment</div>"), "<div>just a fragment</div>");
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
