/**
 * ProofCast Telegram bot (Telegraf).
 *
 * Listens for two plain-text commands and enforces the ProofCast rule:
 *   - "Démo [description]" → generate the feature, record a video proof, and
 *     send it back as MP4. Marks the chat as demo-ready.
 *   - "Déploie"            → deploy to production, but ONLY if a demo was
 *     produced first in this chat. Otherwise the bot asks for "Démo" first.
 *
 * Robustness: every handler is wrapped so a failure (bad AI response, recording
 * error, deploy failure) is reported to the user WITHOUT crashing the bot. A
 * failed demo never marks the chat as demo-ready.
 *
 * The command logic is exported as pure functions (`runDemoCommand` /
 * `runDeployCommand`) so it can be tested without any network.
 */

import { Telegraf } from "telegraf";
import type { Context } from "telegraf";

import { extractHtmlDocument, generateFeature as defaultGenerateFeature } from "./ai.js";
import { deployWithVercel as defaultDeployWithVercel } from "./deployer.js";
import {
  logLiveContext as defaultLogLiveContext,
  resetLiveContext,
  writeMemory as defaultWriteMemory,
} from "./memory.js";
import { loadToken } from "./onboarding.js";
import { recordDemo as defaultRecordDemo } from "./video.js";

/** Dependencies the handlers use — injectable so tests avoid real AI/video/deploy. */
export interface BotDependencies {
  generateFeature: typeof defaultGenerateFeature;
  recordDemo: typeof defaultRecordDemo;
  deployWithVercel: typeof defaultDeployWithVercel;
  /** Append a redacted reasoning entry to proofcast-live.md. */
  logLiveContext: (step: string, details: string) => void;
  /** Persist a redacted entry to the project-scoped memory (fatal errors). */
  writeMemory: (entry: string) => void;
}

const DEFAULT_DEPS: BotDependencies = {
  generateFeature: defaultGenerateFeature,
  recordDemo: defaultRecordDemo,
  deployWithVercel: defaultDeployWithVercel,
  logLiveContext: defaultLogLiveContext,
  writeMemory: defaultWriteMemory,
};

/** Minimal context the handlers need (a small, mockable subset of Telegraf's Context). */
export interface DemoContext {
  chatId: number | string;
  text: string;
  reply(text: string): Promise<unknown>;
  replyWithVideo(
    video: { source: Buffer; filename?: string },
    extra?: { caption?: string },
  ): Promise<unknown>;
}

/** Per-chat state: whether a video proof has been produced this session. */
export interface ChatState {
  demoReady: boolean;
}

export function createChatState(): ChatState {
  return { demoReady: false };
}

/** "Démo", "démo: xyz", "Démo une page de login" → captures the description. */
export const DEMO_KEYWORD = /^d[ée]mo\b\s*:?\s*(.*)$/is;
/** "Déploie", "Deploie", "Déploie maintenant". */
export const DEPLOY_KEYWORD = /^d[ée]ploie\b/i;

/** Used when "Démo" is sent without a description. */
const DEFAULT_FEATURE_DESCRIPTION = "a minimal self-contained demo web page";

/**
 * Handle a "Démo" command: generate the feature, record the proof video, send
 * the MP4, and mark the chat demo-ready. Never throws — failures are reported.
 */
export async function runDemoCommand(
  ctx: DemoContext,
  state: ChatState,
  deps: BotDependencies = DEFAULT_DEPS,
): Promise<void> {
  try {
    const description = (DEMO_KEYWORD.exec(ctx.text)?.[1] ?? "").trim() || DEFAULT_FEATURE_DESCRIPTION;
    deps.logLiveContext("demo", `requested: ${description}`);

    await ctx.reply("🎬 Génération de la feature…");
    // Real models often wrap the HTML in ```fences``` — extract a servable doc.
    const html = extractHtmlDocument(await deps.generateFeature(description));
    deps.logLiveContext("demo", "feature generated");

    await ctx.reply("🎥 Enregistrement de la preuve vidéo…");
    const demo = await deps.recordDemo({ html });
    deps.logLiveContext("demo", `proof recorded (${demo.sizeBytes} bytes)`);

    // Only mark demo-ready AFTER a successful recording.
    state.demoReady = true;
    await ctx.replyWithVideo(
      { source: demo.video, filename: "proofcast-demo.mp4" },
      { caption: "✅ Preuve vidéo prête. Vérifie-la, puis envoie « Déploie »." },
    );
  } catch (err) {
    state.demoReady = false;
    deps.logLiveContext("demo", `failed: ${errorMessage(err)}`);
    deps.writeMemory(`Démo failed: ${errorMessage(err)}`);
    await safeReply(ctx, `❌ Échec de la démo : ${errorMessage(err)}`);
  }
}

/**
 * Handle a "Déploie" command. Enforces the ProofCast rule: deployment is blocked
 * until a demo has been produced in this chat. Never throws.
 */
export async function runDeployCommand(
  ctx: DemoContext,
  state: ChatState,
  deps: BotDependencies = DEFAULT_DEPS,
): Promise<void> {
  try {
    if (!state.demoReady) {
      deps.logLiveContext("deploy", "blocked: no demo produced yet");
      await ctx.reply(
        "🚫 Lance d'abord « Démo ». ProofCast exige une preuve vidéo avant tout déploiement.",
      );
      return;
    }
    deps.logLiveContext("deploy", "starting");
    await ctx.reply("🚀 Déploiement en production…");
    const result = deps.deployWithVercel();
    deps.logLiveContext("deploy", `deployed: ${result.url}`);
    await ctx.reply(`✅ Déployé : ${result.url}`);
  } catch (err) {
    deps.logLiveContext("deploy", `failed: ${errorMessage(err)}`);
    deps.writeMemory(`Déploie failed: ${errorMessage(err)}`);
    await safeReply(ctx, `❌ Échec du déploiement : ${errorMessage(err)}`);
  }
}

/**
 * Build a configured Telegraf bot (without launching it). Wires the two command
 * handlers and a last-resort error guard. Exported for wiring/tests.
 */
export function buildBot(token: string, deps: BotDependencies = DEFAULT_DEPS): Telegraf {
  const bot = new Telegraf(token);
  const states = new Map<number | string, ChatState>();
  const stateFor = (id: number | string): ChatState => {
    let state = states.get(id);
    if (!state) {
      state = createChatState();
      states.set(id, state);
    }
    return state;
  };

  bot.hears(DEMO_KEYWORD, (ctx) => runDemoCommand(adaptContext(ctx), stateFor(chatIdOf(ctx)), deps));
  bot.hears(DEPLOY_KEYWORD, (ctx) =>
    runDeployCommand(adaptContext(ctx), stateFor(chatIdOf(ctx)), deps),
  );

  // Last-resort guard: a handler error must never crash the bot.
  bot.catch((err, ctx) => {
    deps.writeMemory(`Fatal bot error: ${errorMessage(err)}`);
    void ctx.reply(`❌ Erreur interne : ${errorMessage(err)}`).catch(() => {
      /* ignore */
    });
  });

  return bot;
}

/**
 * Start the bot: use the given token or the one saved by onboarding, build the
 * bot, and launch it (long-running). Returns the Telegraf instance so the caller
 * can stop it.
 *
 * @throws if no token is available.
 */
export async function startBot(
  botToken?: string,
  deps: BotDependencies = DEFAULT_DEPS,
): Promise<Telegraf> {
  const token = (botToken ?? loadToken() ?? "").trim();
  if (token.length === 0) {
    throw new Error(
      "No Telegram token available. Complete onboarding (saveToken) or pass a token to startBot().",
    );
  }

  // Fresh live-context file for this session, then wire and launch.
  resetLiveContext();
  deps.logLiveContext("session", "bot starting");

  const bot = buildBot(token, deps);
  // launch() resolves only when the bot stops; don't await it here.
  bot.launch().catch((error) => {
    // A fatal launch error (e.g. invalid token) — surfaced without secrets.
    // Step 9 will route this through the redacted memory log.
    console.error("ProofCast bot failed to launch:", errorMessage(error));
  });
  return bot;
}

function chatIdOf(ctx: Context): number | string {
  return ctx.chat?.id ?? "unknown";
}

function adaptContext(ctx: Context): DemoContext {
  const message = ctx.message;
  const text = message && "text" in message ? message.text : "";
  return {
    chatId: chatIdOf(ctx),
    text,
    reply: (content) => ctx.reply(content),
    replyWithVideo: (video, extra) =>
      ctx.replyWithVideo(
        { source: video.source, filename: video.filename ?? "proofcast-demo.mp4" },
        extra,
      ),
  };
}

async function safeReply(ctx: DemoContext, text: string): Promise<void> {
  try {
    await ctx.reply(text);
  } catch {
    /* a reply failure must not mask the original error or crash the bot */
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
