/**
 * Browser tools — navigate, fill forms, extract data, screenshot.
 *
 * A browser is STATEFUL (goto → click → extract all act on the same live page), so
 * unlike the fs/shell tools these share one {@link BrowserSession}. The default
 * session lazy-launches Chromium the same way src/video.ts does (~78 MB, only paid
 * on first real navigation); tests inject a fake session so no browser is launched.
 *
 * Contract, as everywhere in the tool layer:
 *   - Expected failures (bad selector, nav timeout, session error) come back as
 *     `{ ok:false, error }`, never a throw.
 *   - Extraction output is byte-capped so a huge page can't blow up the context.
 *   - `browser_screenshot` writes the PNG INSIDE the jail (via {@link resolveInRoot})
 *     and returns its path — never a giant base64 blob in the result.
 *
 * The caller (the agent loop, step 15) owns the session's lifecycle: it creates one
 * session, registers these tools, and calls `session.close()` (or `browser_close`)
 * in a `finally` so no browser leaks.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Type-only: playwright is heavy and lazy-loaded inside the session.
import type { Browser, BrowserContext, Page } from "playwright";

import {
  fail,
  ok,
  resolveInRoot,
  ToolPathEscapeError,
  type Tool,
  type ToolResult,
} from "./registry.js";
import { assertSafeHttpUrl, UnsafeUrlError } from "./url-guard.js";

/** Default byte cap on `browser_extract` output. */
export const DEFAULT_MAX_EXTRACT_BYTES = 50_000;

/** Default filename a screenshot is written to when the caller gives no path. */
export const DEFAULT_SCREENSHOT_PATH = "screenshot.png";

/** Outcome of a navigation. */
export interface NavigationResult {
  /** HTTP status of the main response (0 if unavailable). */
  status: number;
  /** The URL the page actually landed on (after redirects). */
  url: string;
}

/**
 * A live browser the tools drive. One session is shared across a run and MUST be
 * closed by the caller. Injectable so the tools can be tested without Chromium.
 */
export interface BrowserSession {
  goto(url: string): Promise<NavigationResult>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  /** Rendered text of `selector` (or the whole page body when omitted). */
  extractText(selector?: string): Promise<string>;
  /** HTML of `selector` (or the whole document when omitted). */
  extractHtml(selector?: string): Promise<string>;
  /** A PNG screenshot of the current page. */
  screenshot(): Promise<Buffer>;
  /** Tear the browser down. Idempotent. */
  close(): Promise<void>;
}

export interface BrowserSessionOptions {
  /** Navigation timeout (ms). */
  navTimeoutMs?: number;
  /** Per-interaction timeout so a wrong selector fails fast, not after 30 s (ms). */
  stepTimeoutMs?: number;
  /** Viewport / screenshot size. */
  viewport?: { width: number; height: number };
}

/** The default, Chromium-backed {@link BrowserSession} (lazy-launched). */
export function createBrowserSession(options: BrowserSessionOptions = {}): BrowserSession {
  const navTimeout = options.navTimeoutMs ?? 15_000;
  const stepTimeout = options.stepTimeoutMs ?? 5_000;
  const viewport = options.viewport ?? { width: 1280, height: 720 };

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  const ensurePage = async (): Promise<Page> => {
    if (page) return page;
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
    context = await browser.newContext({ viewport });
    page = await context.newPage();
    return page;
  };

  return {
    async goto(url) {
      const p = await ensurePage();
      const response = await p.goto(url, { waitUntil: "load", timeout: navTimeout });
      return { status: response?.status() ?? 0, url: p.url() };
    },
    async click(selector) {
      const p = await ensurePage();
      await p.locator(selector).first().click({ timeout: stepTimeout });
    },
    async fill(selector, value) {
      const p = await ensurePage();
      await p.locator(selector).first().fill(value, { timeout: stepTimeout });
    },
    async extractText(selector) {
      const p = await ensurePage();
      const locator = selector ? p.locator(selector).first() : p.locator("body");
      return locator.innerText({ timeout: stepTimeout });
    },
    async extractHtml(selector) {
      const p = await ensurePage();
      if (selector) {
        return p.locator(selector).first().innerHTML({ timeout: stepTimeout });
      }
      return p.content();
    },
    async screenshot() {
      const p = await ensurePage();
      return p.screenshot();
    },
    async close() {
      // Best-effort, idempotent teardown — no browser must ever leak.
      try {
        await context?.close();
      } catch {
        /* already closing */
      }
      try {
        await browser?.close();
      } catch {
        /* already closing */
      }
      context = undefined;
      browser = undefined;
      page = undefined;
    },
  };
}

export interface BrowserToolsOptions {
  /** Byte cap on `browser_extract` output (default {@link DEFAULT_MAX_EXTRACT_BYTES}). */
  maxExtractBytes?: number;
  /** Allow navigating to private/loopback hosts (default: blocked — SSRF guard). */
  allowPrivate?: boolean;
}

/** The browser tools, all driving the shared `session`. */
export function createBrowserTools(session: BrowserSession, options: BrowserToolsOptions = {}): Tool[] {
  const maxExtract = options.maxExtractBytes ?? DEFAULT_MAX_EXTRACT_BYTES;
  return [
    browserGoto(session, options.allowPrivate ?? false),
    browserClick(session),
    browserFill(session),
    browserExtract(session, maxExtract),
    browserScreenshot(session),
    browserClose(session),
  ];
}

function browserGoto(session: BrowserSession, allowPrivate: boolean): Tool {
  return {
    name: "browser_goto",
    description: "Navigate the shared browser to a URL and report the HTTP status and final URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute http(s) URL to open." } },
      required: ["url"],
    },
    async run(input) {
      const url = readStringProp(input, "url");
      if (url === undefined) return fail('browser_goto requires a non-empty "url" string.');
      try {
        // Scheme + SSRF check (private/loopback/metadata) BEFORE navigating.
        assertSafeHttpUrl(url, { allowPrivate });
      } catch (err) {
        if (err instanceof UnsafeUrlError) return fail(err.message);
        throw err;
      }
      return guard(() => session.goto(url), "browser_goto");
    },
  };
}

function browserClick(session: BrowserSession): Tool {
  return {
    name: "browser_click",
    description: "Click the first element matching a CSS selector on the current page.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS selector to click." } },
      required: ["selector"],
    },
    async run(input) {
      const selector = readStringProp(input, "selector");
      if (selector === undefined) return fail('browser_click requires a non-empty "selector" string.');
      return guard(async () => {
        await session.click(selector);
        return { selector };
      }, "browser_click");
    },
  };
}

function browserFill(session: BrowserSession): Tool {
  return {
    name: "browser_fill",
    description: "Fill the first input matching a CSS selector with a value.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the input." },
        value: { type: "string", description: "Value to type into it." },
      },
      required: ["selector", "value"],
    },
    async run(input) {
      const selector = readStringProp(input, "selector");
      if (selector === undefined) return fail('browser_fill requires a non-empty "selector" string.');
      const value = readValueProp(input);
      if (value === undefined) return fail('browser_fill requires a "value" string.');
      return guard(async () => {
        await session.fill(selector, value);
        return { selector };
      }, "browser_fill");
    },
  };
}

function browserExtract(session: BrowserSession, maxBytes: number): Tool {
  return {
    name: "browser_extract",
    description: "Extract text (default) or HTML from the page, optionally scoped to a CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Optional CSS selector to scope extraction (default: whole page)." },
        format: { type: "string", enum: ["text", "html"], description: "text (default) or html." },
      },
      required: [],
    },
    async run(input) {
      const selector = readStringProp(input, "selector");
      const format = readStringProp(input, "format") === "html" ? "html" : "text";
      return guard(async () => {
        const raw = format === "html" ? await session.extractHtml(selector) : await session.extractText(selector);
        const truncated = Buffer.byteLength(raw, "utf8") > maxBytes;
        const content = truncated ? Buffer.from(raw, "utf8").subarray(0, maxBytes).toString("utf8") : raw;
        return { format, selector: selector ?? null, content, truncated };
      }, "browser_extract");
    },
  };
}

function browserScreenshot(session: BrowserSession): Tool {
  return {
    name: "browser_screenshot",
    description: "Screenshot the current page and save the PNG inside the project root; returns its path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: `Path for the PNG, relative to the project root (default: ${DEFAULT_SCREENSHOT_PATH}).` },
      },
      required: [],
    },
    async run(input, ctx) {
      const rel = readStringProp(input, "path") ?? DEFAULT_SCREENSHOT_PATH;
      let target: string;
      try {
        target = resolveInRoot(ctx.root, rel);
      } catch (err) {
        if (err instanceof ToolPathEscapeError) return fail(err.message);
        throw err;
      }
      return guard(async () => {
        const png = await session.screenshot();
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, png);
        return { path: rel, bytes: png.length };
      }, "browser_screenshot");
    },
  };
}

function browserClose(session: BrowserSession): Tool {
  return {
    name: "browser_close",
    description: "Close the shared browser and release its resources.",
    inputSchema: { type: "object", properties: {}, required: [] },
    async run() {
      return guard(async () => {
        await session.close();
        return { closed: true };
      }, "browser_close");
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Run a session action, turning any thrown Playwright/session error into a failed result. */
async function guard(action: () => Promise<unknown>, tool: string): Promise<ToolResult> {
  try {
    return ok(await action());
  } catch (err) {
    return fail(`${tool} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Read a required non-empty string property from untrusted model input. */
function readStringProp(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read the `value` property (an empty string is valid — clearing a field). */
function readValueProp(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>).value;
  return typeof value === "string" ? value : undefined;
}
