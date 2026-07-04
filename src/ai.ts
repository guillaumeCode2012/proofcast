/**
 * ProofCast AI feature generation — multi-provider.
 *
 * The user connects whichever AI they want. ProofCast does NOT pre-select a
 * provider or a model:
 *   - Provider: `options.provider` (an instance or "anthropic" | "openai"),
 *     else `PROOFCAST_AI_PROVIDER`, else auto-detected from whichever API key
 *     is present. A custom provider can be injected to support "any other" AI.
 *   - Model: per-provider env var (`ANTHROPIC_MODEL` / `OPENAI_MODEL`) or
 *     `options.model`. Missing model / key throw clear errors before any call.
 *
 * For ProofCast's proof-before-deploy flow, the default system prompt asks for a
 * single self-contained HTML document so the result can be served and demoed
 * directly (see src/video.ts).
 */

// Type-only: the SDKs are heavy (~12–13 MB RSS each) and only ONE provider is
// ever used per install, so the real modules are loaded lazily at first call.
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";

import { analyzeTargetDirectory } from "./context-analyzer.js";
import { readRecentMemory } from "./memory.js";

/**
 * Non-streaming max output tokens. This is a cap, not a target: the model stops
 * when the document is done. It is kept deliberately low because a ProofCast demo
 * is a single-screen page (a few KB of HTML) — a smaller cap bounds the worst-case
 * generation time so the whole demo pipeline stays within its ~1 min budget.
 * Override per call with `options.maxTokens`.
 */
export const DEFAULT_MAX_TOKENS = 4096;

/**
 * Wall-clock backstop for a single AI generation (ms). The Anthropic/OpenAI SDKs
 * default to a 10-minute timeout, so a slow or stalled model would hang the demo
 * far past its budget. This caps that. Override with `PROOFCAST_AI_TIMEOUT_MS`.
 */
export const DEFAULT_AI_TIMEOUT_MS = 60_000;

/**
 * Default system prompt: emit a demo-able, self-contained HTML feature. It asks
 * for a COMPACT single-screen page on purpose — fewer output tokens means the
 * model responds faster, which is what keeps a "Démo" under a minute.
 */
export const DEFAULT_SYSTEM_PROMPT =
  "You are a senior engineer inside ProofCast. Given a short feature request, " +
  "produce a SINGLE self-contained HTML document (inline CSS and JS, no external " +
  "dependencies or build step) that implements the feature so it can be served " +
  "and demonstrated directly in a browser. Keep it COMPACT and focused: one screen " +
  "that clearly shows the feature working, concise inline CSS, and only the JS the " +
  "demo needs — no placeholder filler, no long copy, no unrelated sections. Output " +
  "only the HTML document — no markdown fences, no explanation.";

/**
 * System prompt for BROWNFIELD generation (modifying an existing project). Unlike
 * the greenfield prompt, the model must return a JSON array of per-file changes,
 * reuse existing files instead of recreating them, and leave unrelated code alone.
 */
export const BROWNFIELD_SYSTEM_PROMPT =
  "You are a senior engineer inside ProofCast working in BROWNFIELD mode on an " +
  "EXISTING project. You are given the current project (a file tree and file " +
  "contents) and a change request. Rules: (1) If the feature already lives in a " +
  "file, MODIFY that file — do NOT create a new file for it. (2) Return ONLY a " +
  "JSON array where each element is {\"path\": string, \"action\": \"modify\" | " +
  "\"create\", \"content\": string}. \"modify\" = an existing file you are " +
  "rewriting in full; \"create\" = a genuinely new file. \"content\" is the " +
  "COMPLETE new content of that file. (3) Preserve ALL code unrelated to the " +
  "request — change only what the feature needs. (4) Include only the files you " +
  "actually change. Output only the JSON array — no markdown fences, no prose.";

/** One file-level change returned by the model in brownfield mode. */
export interface FileChange {
  /** Path of the file, relative to the target directory. */
  path: string;
  /** `modify` an existing file, or `create` a genuinely new one. */
  action: "modify" | "create";
  /** The complete new content of the file. */
  content: string;
}

/** Thrown when a brownfield response is not a valid `FileChange[]` JSON array. */
export class InvalidBrownfieldResponseError extends Error {
  constructor(reason: string) {
    super(`The model did not return a valid brownfield change set: ${reason}.`);
    this.name = "InvalidBrownfieldResponseError";
  }
}

/** Resolve the per-call AI timeout from the environment, falling back to the default. */
function aiTimeoutMs(): number {
  const raw = Number(process.env.PROOFCAST_AI_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AI_TIMEOUT_MS;
}

/** Thrown when the required API key is not set in the environment. */
export class MissingApiKeyError extends Error {
  constructor(envVar: string) {
    super(
      `${envVar} is not set. ProofCast expects your provider's API key to be present ` +
        `in the environment and never requests it interactively. Export ${envVar} and retry.`,
    );
    this.name = "MissingApiKeyError";
  }
}

/** Thrown when no model is configured (ProofCast never picks one for you). */
export class MissingModelError extends Error {
  constructor(envVar: string) {
    super(
      `No model configured. ProofCast does not pre-select a model: set ${envVar} in the ` +
        `environment (or pass options.model) to the model you connected.`,
    );
    this.name = "MissingModelError";
  }
}

/** Thrown when the model refuses or returns no usable text. */
export class EmptyFeatureResponseError extends Error {
  constructor(reason: string | null) {
    super(`The model returned no usable feature text (reason: ${reason ?? "unknown"}).`);
    this.name = "EmptyFeatureResponseError";
  }
}

/** Thrown when a provider name is not recognized. */
export class UnknownProviderError extends Error {
  constructor(name: string) {
    super(`Unknown AI provider "${name}". Use "anthropic", "openai", or inject a custom AiProvider.`);
    this.name = "UnknownProviderError";
  }
}

/** Thrown when no provider can be resolved (no selector, env, or API key present). */
export class NoProviderConfiguredError extends Error {
  constructor() {
    super(
      "No AI provider configured. Set PROOFCAST_AI_PROVIDER, or provide an API key " +
        "(ANTHROPIC_API_KEY / OPENAI_API_KEY), or pass options.provider.",
    );
    this.name = "NoProviderConfiguredError";
  }
}

/** Per-call knobs passed to a provider. */
export interface ProviderCallOptions {
  model?: string;
  maxTokens?: number;
  system?: string;
}

/** A pluggable AI backend. Implement this to support any provider ("ou autre"). */
export interface AiProvider {
  readonly name: string;
  generateFeature(description: string, options?: ProviderCallOptions): Promise<string>;
}

export interface AnthropicProviderConfig {
  /** Inject a client (or mock). When set, no API key is required. */
  client?: Anthropic;
  apiKey?: string;
  model?: string;
}

export interface OpenAiProviderConfig {
  client?: OpenAI;
  apiKey?: string;
  model?: string;
  /** OpenAI-compatible base URL (Codex/OpenAI/self-hosted). Falls back to OPENAI_BASE_URL. */
  baseURL?: string;
}

/** Provider built on `@anthropic-ai/sdk` (Claude). */
export function createAnthropicProvider(config: AnthropicProviderConfig = {}): AiProvider {
  return {
    name: "anthropic",
    async generateFeature(description, options = {}) {
      const model = requireModel(config.model ?? options.model, "ANTHROPIC_MODEL");
      let client = config.client;
      if (!client) {
        // Validate the key BEFORE loading the SDK, then lazy-load it: the
        // module costs ~12 MB RSS and is only needed on this provider's path.
        const apiKey = requireApiKey(config.apiKey, "ANTHROPIC_API_KEY");
        const { default: AnthropicSdk } = await import("@anthropic-ai/sdk");
        client = new AnthropicSdk({ apiKey, timeout: aiTimeoutMs(), maxRetries: 1 });
      }

      const response = await client.messages.create({
        model,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: options.system ?? DEFAULT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: description }],
      });

      if (response.stop_reason === "refusal") {
        throw new EmptyFeatureResponseError("refusal");
      }
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (text.length === 0) {
        throw new EmptyFeatureResponseError(response.stop_reason);
      }
      return text;
    },
  };
}

/** Provider built on the OpenAI SDK (OpenAI / Codex / any OpenAI-compatible endpoint). */
export function createOpenAiProvider(config: OpenAiProviderConfig = {}): AiProvider {
  return {
    name: "openai",
    async generateFeature(description, options = {}) {
      const model = requireModel(config.model ?? options.model, "OPENAI_MODEL");
      let client = config.client;
      if (!client) {
        // Same lazy pattern as the Anthropic provider (~13 MB RSS deferred).
        const apiKey = requireApiKey(config.apiKey, "OPENAI_API_KEY");
        const { default: OpenAiSdk } = await import("openai");
        client = new OpenAiSdk({
          apiKey,
          baseURL: config.baseURL ?? process.env.OPENAI_BASE_URL,
          timeout: aiTimeoutMs(),
          maxRetries: 1,
        });
      }

      const completion = await client.chat.completions.create({
        model,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: [
          { role: "system", content: options.system ?? DEFAULT_SYSTEM_PROMPT },
          { role: "user", content: description },
        ],
      });

      const choice = completion.choices[0];
      const text = (choice?.message?.content ?? "").trim();
      if (text.length === 0) {
        throw new EmptyFeatureResponseError(choice?.finish_reason ?? null);
      }
      return text;
    },
  };
}

/** How a provider is chosen: an instance, a known name, or (undefined) auto. */
export type ProviderSelector = AiProvider | "anthropic" | "openai";

/**
 * Resolve the provider to use.
 * @throws {UnknownProviderError}       for an unrecognized name.
 * @throws {NoProviderConfiguredError}  when nothing indicates a provider.
 */
export function resolveProvider(selector?: ProviderSelector): AiProvider {
  if (selector && typeof selector !== "string") {
    return selector; // injected custom instance
  }
  const name = (selector ?? process.env.PROOFCAST_AI_PROVIDER ?? autoDetectProvider()).toLowerCase();
  switch (name) {
    case "anthropic":
      return createAnthropicProvider();
    case "openai":
      return createOpenAiProvider();
    default:
      throw new UnknownProviderError(name);
  }
}

export interface GenerateFeatureOptions extends ProviderCallOptions {
  /** Provider to use (instance | "anthropic" | "openai"). Defaults to env / auto-detect. */
  provider?: ProviderSelector;
  /**
   * Project-memory injection into the system prompt. `false` disables it; an
   * object overrides where memory is read from; default reads the project memory.
   */
  memory?: false | { cwd?: string; homeDir?: string };
  /**
   * BROWNFIELD mode. When set, the existing project at this path is analyzed
   * (see {@link analyzeTargetDirectory}) and injected into the prompt, and the
   * model is asked to return a per-file change set ({@link FileChange}[]) instead
   * of a single HTML document. When omitted, generation is greenfield (unchanged).
   */
  targetDir?: string;
}

/**
 * Generate a feature implementation from a natural-language description, using
 * whichever provider the user connected.
 *
 * @throws {TypeError}                 if `description` is empty/blank.
 * @throws {MissingModelError}         if no model is configured.
 * @throws {MissingApiKeyError}        if the provider needs a key and none is set.
 * @throws {EmptyFeatureResponseError} if the model refuses or returns no text.
 */
export async function generateFeature(
  description: string,
  options: GenerateFeatureOptions = {},
): Promise<string> {
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new TypeError("Feature description is required and must be a non-empty string.");
  }
  const provider = resolveProvider(options.provider);

  // Brownfield: analyze the existing project first, inject it into the prompt,
  // and switch the model to the change-set contract. Greenfield is unchanged.
  if (options.targetDir !== undefined) {
    const context = await analyzeTargetDirectory(options.targetDir);
    return provider.generateFeature(buildBrownfieldUserMessage(description, context), {
      model: options.model,
      maxTokens: options.maxTokens,
      system: buildSystemPromptWithMemory(options, BROWNFIELD_SYSTEM_PROMPT),
    });
  }

  return provider.generateFeature(description, {
    model: options.model,
    maxTokens: options.maxTokens,
    system: buildSystemPromptWithMemory(options),
  });
}

/** Assemble the user turn for a brownfield generation: the project, then the ask. */
function buildBrownfieldUserMessage(description: string, context: string): string {
  return (
    "Here is the existing project you must modify. Reuse and edit these files; " +
    "do not recreate what already exists.\n\n" +
    `${context}\n\n## Requested change\n${description}`
  );
}

/**
 * Parse a brownfield model response into a validated {@link FileChange}[].
 * Tolerates a ```json fence or surrounding prose by isolating the outermost
 * JSON array. Throws {@link InvalidBrownfieldResponseError} on anything invalid.
 */
export function parseBrownfieldResponse(text: string): FileChange[] {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new InvalidBrownfieldResponseError("empty response");
  }

  let body = text.trim();
  const fenced = body.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenced?.[1]) {
    body = fenced[1].trim();
  }
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end < start) {
    throw new InvalidBrownfieldResponseError("no JSON array found");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (err) {
    throw new InvalidBrownfieldResponseError(
      `invalid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new InvalidBrownfieldResponseError("top-level value is not an array");
  }

  return parsed.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new InvalidBrownfieldResponseError(`element ${i} is not an object`);
    }
    const { path, action, content } = raw as Record<string, unknown>;
    if (typeof path !== "string" || path.trim().length === 0) {
      throw new InvalidBrownfieldResponseError(`element ${i} has an invalid "path"`);
    }
    if (action !== "modify" && action !== "create") {
      throw new InvalidBrownfieldResponseError(`element ${i} has an invalid "action"`);
    }
    if (typeof content !== "string") {
      throw new InvalidBrownfieldResponseError(`element ${i} has an invalid "content"`);
    }
    return { path, action, content };
  });
}

/**
 * Hard cap (chars) on the memory block injected into the system prompt —
 * roughly 500 tokens. Without it, a few long error entries in memory would
 * silently inflate the input tokens of EVERY subsequent generation.
 */
export const MAX_MEMORY_PROMPT_CHARS = 2000;

/**
 * Inject the last 10 (already-redacted) memory lines into the system prompt so
 * the model learns from prior sessions, capped at {@link MAX_MEMORY_PROMPT_CHARS}
 * (whole lines, most recent kept first). Returns `options.system` unchanged when
 * memory is disabled or empty.
 */
function buildSystemPromptWithMemory(
  options: GenerateFeatureOptions,
  defaultPrompt: string = DEFAULT_SYSTEM_PROMPT,
): string | undefined {
  if (options.memory === false) {
    return options.system ?? defaultPrompt;
  }
  const recent = capLines(readRecentMemory(10, options.memory ?? {}), MAX_MEMORY_PROMPT_CHARS);
  const base = options.system ?? defaultPrompt;
  if (recent.trim().length === 0) {
    return base;
  }
  return `${base}\n\n## Recent ProofCast context (last actions, redacted)\n${recent}`;
}

/** Keep whole lines from the END (most recent) of `text` within `maxChars`. */
function capLines(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const kept: string[] = [];
  let budget = maxChars;
  for (const line of text.split("\n").reverse()) {
    // +1 for the newline that rejoins the lines.
    if (line.length + 1 > budget) break;
    kept.unshift(line);
    budget -= line.length + 1;
  }
  // Degenerate case (first line alone exceeds the budget): hard-truncate it.
  return kept.length > 0 ? kept.join("\n") : text.slice(-maxChars);
}

/** Pick a provider name from whichever API key is present. */
function autoDetectProvider(): string {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "anthropic";
  if (process.env.OPENAI_API_KEY?.trim()) return "openai";
  throw new NoProviderConfiguredError();
}

/** Resolve a model from an explicit value or the given env var. */
function requireModel(explicit: string | undefined, envVar: string): string {
  const model = (explicit ?? process.env[envVar] ?? "").trim();
  if (model.length === 0) {
    throw new MissingModelError(envVar);
  }
  return model;
}

/** Resolve an API key from an explicit value or the given env var. */
function requireApiKey(explicit: string | undefined, envVar: string): string {
  const key = explicit ?? process.env[envVar];
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new MissingApiKeyError(envVar);
  }
  return key;
}

/**
 * Extract a servable HTML document from raw model output. Real models often wrap
 * HTML in ```html fences or add prose; serving that verbatim breaks the demo.
 * Strips a code fence if present, then isolates the `<!doctype html>…</html>`
 * document. Returns the trimmed text unchanged when it's already plain HTML.
 */
export function extractHtmlDocument(text: string): string {
  if (typeof text !== "string") {
    return "";
  }
  let out = text.trim();

  const fenced = out.match(/```(?:html)?\s*\n?([\s\S]*?)```/i);
  if (fenced?.[1]) {
    out = fenced[1].trim();
  }

  const start = out.match(/<!doctype html>|<html[\s>]/i);
  if (start && typeof start.index === "number") {
    const end = out.toLowerCase().lastIndexOf("</html>");
    return end >= 0 ? out.slice(start.index, end + "</html>".length) : out.slice(start.index);
  }
  return out;
}
