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

import { Markup, Telegraf } from "telegraf";
import type { Context } from "telegraf";

import { extractHtmlDocument, generateFeature as defaultGenerateFeature } from "./ai.js";
import { deployWithVercel as defaultDeployWithVercel } from "./deployer.js";
import {
  logLiveContext as defaultLogLiveContext,
  resetLiveContext,
  writeMemory as defaultWriteMemory,
} from "./memory.js";
import { loadToken } from "./onboarding.js";
import { executeAndHeal as defaultExecuteAndHeal } from "./orchestrator.js";
import {
  DirectoryNotFoundError,
  isPathLikeHint,
  resolveAnyDirectory as defaultResolveAnyDirectory,
  stripQuotes,
} from "./path-resolver.js";
import { isDockerAvailable as defaultIsDockerAvailable } from "./sandbox.js";
import { recordDemo as defaultRecordDemo } from "./video.js";

/** Dependencies the handlers use — injectable so tests avoid real AI/video/deploy. */
export interface BotDependencies {
  generateFeature: typeof defaultGenerateFeature;
  recordDemo: typeof defaultRecordDemo;
  deployWithVercel: typeof defaultDeployWithVercel;
  /** Brownfield self-heal on an existing project (used when a target folder is given). */
  executeAndHeal: typeof defaultExecuteAndHeal;
  /** Resolve a folder hint (path anywhere, or a project-scoped name) to a directory. */
  resolveAnyDirectory: typeof defaultResolveAnyDirectory;
  /** Whether a usable Docker daemon is available (sandbox vs. local fallback). */
  isDockerAvailable: typeof defaultIsDockerAvailable;
  /** Append a redacted reasoning entry to proofcast-live.md. */
  logLiveContext: (step: string, details: string) => void;
  /** Persist a redacted entry to the project-scoped memory (fatal errors). */
  writeMemory: (entry: string) => void;
}

const DEFAULT_DEPS: BotDependencies = {
  generateFeature: defaultGenerateFeature,
  recordDemo: defaultRecordDemo,
  deployWithVercel: defaultDeployWithVercel,
  executeAndHeal: defaultExecuteAndHeal,
  resolveAnyDirectory: defaultResolveAnyDirectory,
  isDockerAvailable: defaultIsDockerAvailable,
  logLiveContext: defaultLogLiveContext,
  writeMemory: defaultWriteMemory,
};

/** Where the user can learn to install Docker (the fallback message's button). */
export const DOCKER_INSTALL_URL = "https://docs.docker.com/get-docker/";

/** Options for a text reply (optionally with a single inline URL button). */
export interface ReplyOptions {
  /** Render one inline URL button under the message. */
  buttonUrl?: { text: string; url: string };
}

/** Minimal context the handlers need (a small, mockable subset of Telegraf's Context). */
export interface DemoContext {
  chatId: number | string;
  text: string;
  reply(text: string, options?: ReplyOptions): Promise<unknown>;
  replyWithVideo(
    video: { source: Buffer; filename?: string },
    extra?: VideoExtra,
  ): Promise<unknown>;
}

/**
 * Metadata sent alongside the video. Passing width/height/duration and
 * `supports_streaming` lets Telegram deliver the clip immediately instead of
 * probing and re-processing the file — that's what keeps the gap between "demo
 * recorded" and "user has it" down to a few seconds.
 */
export interface VideoExtra {
  caption?: string;
  width?: number;
  height?: number;
  duration?: number;
  supports_streaming?: boolean;
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
 * Separator between an optional target folder and the description:
 * `Démo <folder> | <description>`. A pipe is unambiguous even with Windows
 * `C:\…` paths (which contain a `:`). No pipe → greenfield generation.
 */
export const DEMO_FOLDER_SEPARATOR = "|";

/**
 * Split a "Démo" message into an optional target folder and a description.
 * A target is recognized ONLY when the part before the pipe is an explicit,
 * path-like location — so a stray `|` in a plain description stays greenfield:
 *   `Démo /path/to/app | add a reset button` → folder + description (brownfield)
 *   `Démo ./app | add a button`              → folder + description (brownfield)
 *   `Démo a page with A | B options`         → no folder, `|` kept literal (greenfield)
 *   `Démo a login page`                      → no folder (greenfield)
 */
export function parseDemoText(text: string): { folderHint: string | null; description: string } {
  const tail = (DEMO_KEYWORD.exec(text)?.[1] ?? "").trim();
  const sep = tail.indexOf(DEMO_FOLDER_SEPARATOR);
  if (sep !== -1) {
    const candidate = stripQuotes(tail.slice(0, sep).trim());
    if (candidate.length > 0 && isPathLikeHint(candidate)) {
      return { folderHint: candidate, description: tail.slice(sep + 1).trim() };
    }
  }
  return { folderHint: null, description: tail };
}

/**
 * Handle a "Démo" command. With a target folder it runs the brownfield self-heal
 * pipeline on an existing project; otherwise it generates a self-contained demo
 * from scratch. Either way it records a proof, sends the MP4, and marks the chat
 * demo-ready. Never throws — failures are reported to the user.
 */
export async function runDemoCommand(
  ctx: DemoContext,
  state: ChatState,
  deps: BotDependencies = DEFAULT_DEPS,
): Promise<void> {
  try {
    const { folderHint, description: parsed } = parseDemoText(ctx.text);
    const description = parsed || DEFAULT_FEATURE_DESCRIPTION;

    if (folderHint) {
      await runBrownfieldDemo(ctx, state, deps, folderHint, description);
    } else {
      await runGreenfieldDemo(ctx, state, deps, description);
    }
  } catch (err) {
    state.demoReady = false;
    deps.logLiveContext("demo", `failed: ${errorMessage(err)}`);
    deps.writeMemory(`Démo failed: ${errorMessage(err)}`);
    await safeReply(ctx, `❌ Échec de la démo : ${errorMessage(err)}`);
  }
}

/** Greenfield: generate a self-contained HTML feature and record it. */
async function runGreenfieldDemo(
  ctx: DemoContext,
  state: ChatState,
  deps: BotDependencies,
  description: string,
): Promise<void> {
  deps.logLiveContext("demo", `requested (greenfield): ${description}`);

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
    {
      caption: "✅ Preuve vidéo prête. Vérifie-la, puis envoie « Déploie ».",
      // Metadata so Telegram delivers immediately (no probing / re-encoding).
      width: demo.width,
      height: demo.height,
      duration: demo.durationSec,
      supports_streaming: true,
    },
  );
}

/**
 * Brownfield: resolve the target project (anywhere on the machine), then run the
 * self-heal pipeline in a Docker sandbox — or, if Docker isn't available, fall
 * back to local execution with a clear warning + an "install Docker" button.
 */
async function runBrownfieldDemo(
  ctx: DemoContext,
  state: ChatState,
  deps: BotDependencies,
  folderHint: string,
  description: string,
): Promise<void> {
  deps.logLiveContext("demo", `requested (brownfield) on "${folderHint}": ${description}`);

  let dir: string | null;
  try {
    dir = await deps.resolveAnyDirectory(folderHint);
  } catch (err) {
    if (err instanceof DirectoryNotFoundError) {
      await ctx.reply(`🚫 Dossier introuvable : « ${folderHint} ». Vérifie le chemin puis réessaie.`);
      return;
    }
    throw err;
  }
  if (!dir) {
    await ctx.reply(
      "🚫 Aucun dossier cible reconnu. Exemple : « Démo /chemin/vers/projet | ajoute un bouton reset ».",
    );
    return;
  }
  await ctx.reply(`📂 Projet cible : ${dir}`);

  // Docker is OPTIONAL: sandbox if available, otherwise run on the host directly.
  const dockerReady = deps.isDockerAvailable();
  if (dockerReady) {
    await ctx.reply("🐳 Docker détecté — exécution dans un conteneur isolé.");
  } else {
    await ctx.reply(
      "⚠️ Docker non détecté. Les outils seront exécutés directement sur votre machine.",
      { buttonUrl: { text: "Installer Docker (recommandé)", url: DOCKER_INSTALL_URL } },
    );
  }

  await ctx.reply("🛠️ Génération, exécution et auto-réparation (jusqu'à 3 tentatives)…");
  const result = await deps.executeAndHeal(description, dir, 3, {
    execution: dockerReady ? "docker" : "local",
  });

  if (!result.success) {
    state.demoReady = false;
    deps.logLiveContext("demo", `heal failed after ${result.attempts} attempt(s): ${result.lastError ?? ""}`);
    await ctx.reply(
      `❌ Feature non fonctionnelle après ${result.attempts} tentative(s). ` +
        `Dernière erreur : ${truncate(result.lastError ?? "inconnue", 300)}`,
    );
    return;
  }

  deps.logLiveContext("demo", `proof recorded (brownfield) in ${result.attempts} attempt(s)`);
  state.demoReady = true;

  if (result.video.length === 0) {
    await ctx.reply(
      `✅ La feature fonctionne (réparée en ${result.attempts} tentative(s)), mais aucune vidéo n'a été capturée.`,
    );
    return;
  }
  await ctx.replyWithVideo(
    { source: result.video, filename: "proofcast-demo.mp4" },
    {
      caption: `✅ Preuve vidéo prête (${result.attempts} tentative(s)). Vérifie-la, puis envoie « Déploie ».`,
      width: 1280,
      height: 720,
      supports_streaming: true,
    },
  );
}

/** Trim `value` to `max` chars, adding an ellipsis when cut. */
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
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
    reply: (content, options) => {
      if (options?.buttonUrl) {
        return ctx.reply(
          content,
          Markup.inlineKeyboard([Markup.button.url(options.buttonUrl.text, options.buttonUrl.url)]),
        );
      }
      return ctx.reply(content);
    },
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
