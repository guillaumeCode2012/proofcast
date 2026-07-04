/**
 * ProofCast demo recording.
 *
 * Spins up a local HTTP server, drives it with Playwright/Chromium, records the
 * session, and returns the demo as an **MP4** (H.264) — the format sent to the
 * user as their "proof" before deploy. Playwright can only capture `.webm`, so
 * we record `.webm` and transcode to MP4 with the bundled ffmpeg binary.
 *
 * Cleanup contract: the local server, the browser context, and the browser are
 * ALWAYS torn down (try/finally), even when recording throws — no zombie
 * processes and no leaked listening sockets. The server closes after the demo.
 *
 * Session flag: on a successful recording we mark that a demo was generated in
 * this session. The bot's ProofCast rule (step 5) blocks "Déploie" until this
 * flag is set. Use {@link hasDemoBeenGenerated} / {@link resetDemoSession}.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Type-only: playwright costs ~78 MB RSS when loaded, but it is only needed
// during the few seconds of an actual recording — so recordDemo() lazy-loads
// it on first use instead of making every `import "proofcast"` pay for it.
import type { Browser, BrowserContext, Page } from "playwright";

const execFileAsync = promisify(execFile);

/** Absolute path to the bundled ffmpeg binary (or null if unavailable). */
const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string | null;

/** Process-wide flag: has a demo been recorded during this session? */
let demoGeneratedThisSession = false;

/** True once {@link recordDemo} has completed successfully in this session. */
export function hasDemoBeenGenerated(): boolean {
  return demoGeneratedThisSession;
}

/** Reset the session flag (new session / tests). */
export function resetDemoSession(): void {
  demoGeneratedThisSession = false;
}

/** Default viewport / video size. */
const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

/** Minimal self-contained page shown when no custom HTML is provided. */
const DEFAULT_DEMO_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ProofCast Demo</title>
<style>
  body { margin:0; font-family:system-ui,sans-serif; background:#0f172a; color:#e2e8f0;
         display:flex; align-items:center; justify-content:center; height:100vh; }
  .card { text-align:center; }
  h1 { font-size:3rem; margin:0 0 .5rem; }
  .pulse { display:inline-block; width:16px; height:16px; border-radius:50%;
           background:#38bdf8; animation:pulse 1s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.8);opacity:.4} }
</style></head>
<body><div class="card"><h1>ProofCast</h1><p>Recording proof <span class="pulse"></span></p></div></body>
</html>`;

/** Sample values used to demonstrate a form (login/signup) in the recording. */
export interface DemoFormData {
  /** Value typed into email fields. */
  email?: string;
  /** Value typed into password fields. */
  password?: string;
  /** Value typed into other plain text fields (name, username, ...). */
  text?: string;
}

const DEMO_FORM_DEFAULTS = {
  email: "demo.user@example.com",
  password: "S3curePassw0rd!",
  text: "Demo User",
} as const;

/**
 * Demonstrate a feature by filling its form the way a user would and submitting.
 * Fills email fields, password fields, then any other plain text fields, and
 * clicks the primary submit button. No-op on pages without matching inputs
 * (e.g. the default demo page). Best-effort: individual fields are skipped
 * rather than throwing, so an unusual layout never breaks the recording.
 */
export async function autoFillDemoForm(page: Page, data: DemoFormData = {}): Promise<void> {
  const email = data.email ?? DEMO_FORM_DEFAULTS.email;
  const password = data.password ?? DEMO_FORM_DEFAULTS.password;
  const text = data.text ?? DEMO_FORM_DEFAULTS.text;

  await fillVisibleFields(
    page,
    'input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]',
    email,
  );
  await fillVisibleFields(page, 'input[type="password"]', password);
  await fillVisibleFields(
    page,
    'input:not([type]), input[type="text"], input[type="search"], input[type="tel"]',
    text,
    true,
  );

  const submit = page
    .locator(
      [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Create")',
        'button:has-text("Sign up")',
        'button:has-text("Register")',
        'button:has-text("Log in")',
        'button:has-text("Login")',
        'button:has-text("Continue")',
      ].join(", "),
    )
    .first();
  if ((await submit.count()) > 0) {
    await submit.click().catch(() => {
      /* non-fatal for a demo */
    });
  }
}

/** Fill every visible field matching `selector`, skipping already-filled ones when asked. */
async function fillVisibleFields(
  page: Page,
  selector: string,
  value: string,
  skipIfFilled = false,
): Promise<void> {
  const fields = page.locator(selector);
  const count = await fields.count();
  for (let i = 0; i < count; i++) {
    const field = fields.nth(i);
    if (!(await field.isVisible().catch(() => false))) continue;
    if (skipIfFilled && (await field.inputValue().catch(() => ""))) continue;
    await field.fill(value).catch(() => {
      /* skip fields that can't be filled */
    });
  }
}

/**
 * A single demo step. The AI agent adapts these to the feature it built:
 *   - a login/signup page → `fill` + `click` (or `autofillForm`),
 *   - a landing page      → `scroll`,
 *   - anything else       → the relevant gestures.
 */
export type DemoAction =
  | { type: "wait"; ms: number }
  | { type: "scroll"; to?: "top" | "bottom"; by?: number; steps?: number }
  | { type: "fill"; selector: string; value: string }
  | { type: "type"; selector: string; text: string; delayMs?: number }
  | { type: "click"; selector: string }
  | { type: "hover"; selector: string }
  | { type: "press"; key: string }
  | { type: "autofillForm"; data?: DemoFormData };

export interface RunDemoActionsOptions {
  /** Fallback form data for `autofillForm` actions. */
  formData?: DemoFormData;
  /** Per-interaction timeout (ms) so a wrong selector fails fast, not after 30s. */
  stepTimeoutMs?: number;
}

/** Run a sequence of demo actions against a page (feature-adaptive demo). */
export async function runDemoActions(
  page: Page,
  actions: DemoAction[],
  options: RunDemoActionsOptions = {},
): Promise<void> {
  const timeout = options.stepTimeoutMs ?? 5000;
  for (const action of actions) {
    switch (action.type) {
      case "wait":
        await page.waitForTimeout(action.ms);
        break;
      case "scroll":
        await scrollThrough(page, action);
        break;
      case "fill":
        await page.locator(action.selector).first().fill(action.value, { timeout });
        break;
      case "type":
        await page
          .locator(action.selector)
          .first()
          .pressSequentially(action.text, { delay: action.delayMs ?? 40, timeout });
        break;
      case "click":
        await page.locator(action.selector).first().click({ timeout });
        break;
      case "hover":
        await page.locator(action.selector).first().hover({ timeout });
        break;
      case "press":
        await page.keyboard.press(action.key);
        break;
      case "autofillForm":
        await autoFillDemoForm(page, action.data ?? options.formData);
        break;
      default: {
        const _exhaustive: never = action;
        void _exhaustive;
      }
    }
  }
}

/**
 * Adaptive default demo: if the page has an auth form (a password field), fill
 * it in and submit — demonstrating a login / account creation; otherwise scroll
 * through the page (landing / static content). The agent can always override
 * with explicit `actions` or `onPage`.
 */
export async function smartDemo(page: Page, formData?: DemoFormData): Promise<void> {
  const hasAuthForm = (await page.locator('input[type="password"]').count()) > 0;
  if (hasAuthForm) {
    await autoFillDemoForm(page, formData);
  } else {
    await scrollThrough(page);
  }
}

/**
 * Generic "look at the page" gesture used as the default demo: scroll down the
 * page in steps (or up, or by a pixel amount). Uses mouse-wheel events so no
 * DOM typings are needed on the Node side.
 */
async function scrollThrough(
  page: Page,
  opts: { to?: "top" | "bottom"; by?: number; steps?: number } = {},
): Promise<void> {
  if (typeof opts.by === "number") {
    await page.mouse.wheel(0, opts.by);
    return;
  }
  const steps = opts.steps ?? 4;
  const delta = opts.to === "top" ? -600 : 600;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(120);
  }
}

export interface RecordDemoOptions {
  /** HTML served by the local demo server (defaults to a built-in demo page). */
  html?: string;
  /** How long to hold the recording after the interaction (ms). */
  durationMs?: number;
  /** Viewport / recorded video size. */
  viewport?: { width: number; height: number };
  /** Feature-adaptive demo steps (login → fill+click, landing → scroll, ...). */
  actions?: DemoAction[];
  /** Fallback form data for `autofillForm` actions. */
  formData?: DemoFormData;
  /** Full custom interaction; when set, REPLACES `actions` and the default scroll. */
  onPage?: (page: Page) => Promise<void>;
  /** Called with the ephemeral port once the local server is listening (tests). */
  onServerListening?: (port: number) => void | Promise<void>;
}

export interface DemoResult {
  /** The recorded demo as an MP4 buffer (ready to send over Telegram). */
  video: Buffer;
  /** Absolute path of the `.mp4` file on disk. */
  videoPath: string;
  /** Absolute path of the intermediate `.webm` capture on disk. */
  webmPath: string;
  /** Size of the MP4 in bytes. */
  sizeBytes: number;
  /** Video width in pixels (Telegram `width` hint → no server-side probing). */
  width: number;
  /** Video height in pixels (Telegram `height` hint). */
  height: number;
  /** Clip duration in whole seconds (Telegram `duration` hint). */
  durationSec: number;
}

/**
 * Record a demo video of the local demo page and return it as MP4.
 *
 * @throws if recording/transcoding fails or produces an empty video. On any
 *         failure the session flag stays unset and all resources are released.
 */
export async function recordDemo(options: RecordDemoOptions = {}): Promise<DemoResult> {
  const html = options.html ?? DEFAULT_DEMO_HTML;
  const durationMs = options.durationMs ?? 800;
  const viewport = options.viewport ?? { ...DEFAULT_VIEWPORT };

  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    const port = await listen(server);
    if (options.onServerListening) {
      await options.onServerListening(port);
    }

    const outDir = await mkdtemp(join(tmpdir(), "proofcast-demo-"));
    // Lazy-load playwright here (first demo only; cached by Node afterwards).
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
    context = await browser.newContext({
      viewport,
      recordVideo: { dir: outDir, size: viewport },
    });

    const page = await context.newPage();
    const video = page.video();
    if (!video) {
      throw new Error("Playwright did not enable video recording for the page.");
    }

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
    if (options.onPage) {
      await options.onPage(page);
    } else if (options.actions && options.actions.length > 0) {
      // Feature-adaptive: run the steps the agent chose for this feature.
      await runDemoActions(page, options.actions, { formData: options.formData });
      await page.waitForTimeout(durationMs);
    } else {
      // No explicit steps: adapt to the feature — fill + submit an auth form if
      // present (login/signup), otherwise scroll through (landing/static).
      await smartDemo(page, options.formData);
      await page.waitForTimeout(durationMs);
    }

    // Closing the context finalizes and flushes the .webm file to disk.
    await context.close();
    context = undefined;
    await browser.close();
    browser = undefined;

    const webmPath = await video.path();
    const { mp4Path: videoPath, durationSec } = await transcodeToMp4(webmPath);
    const buffer = await readFile(videoPath);
    if (buffer.length === 0) {
      throw new Error(`Recorded video is empty: ${videoPath}`);
    }

    demoGeneratedThisSession = true;
    return {
      video: buffer,
      videoPath,
      webmPath,
      sizeBytes: buffer.length,
      width: viewport.width,
      height: viewport.height,
      durationSec,
    };
  } finally {
    // Best-effort teardown — runs on success (no-ops) and on failure.
    if (context) {
      try {
        await context.close();
      } catch {
        /* already closing / closed */
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* already closing / closed */
      }
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    await closeServer(server);
  }
}

/** Result of transcoding: the MP4 path and its duration in whole seconds. */
export interface TranscodeResult {
  mp4Path: string;
  /** Clip duration in seconds (>=1), for the Telegram `duration` hint. */
  durationSec: number;
}

/**
 * Transcode a Playwright `.webm` capture into a broadly-compatible MP4
 * (H.264 / yuv420p, faststart). Uses `execFile` with an argument array — no
 * shell is invoked, so there is no command-injection surface.
 *
 * `-crf 28` keeps a short screen recording small (fast to upload and for
 * Telegram to process), and the clip duration is read straight from ffmpeg's
 * stderr so callers can pass it to Telegram (no separate `ffprobe` needed).
 *
 * Exported so the self-heal orchestrator (src/orchestrator.ts) can record a
 * proof video against a running server without duplicating the ffmpeg pipeline.
 */
export async function transcodeToMp4(webmPath: string): Promise<TranscodeResult> {
  if (!ffmpegPath) {
    throw new Error(
      "ffmpeg binary not found (ffmpeg-static). Cannot produce the MP4 demo.",
    );
  }
  const mp4Path = webmPath.replace(/\.webm$/i, ".mp4");
  const { stderr } = await execFileAsync(
    ffmpegPath,
    [
      "-y",
      "-i", webmPath,
      "-an", // the capture has no audio track; skip audio handling entirely
      "-c:v", "libx264",
      "-preset", "veryfast", // encode faster; the short clip stays small
      "-crf", "28", // smaller file → quicker upload + Telegram processing
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", // moov atom up front so Telegram can stream it
      mp4Path,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return { mp4Path, durationSec: parseDurationSec(stderr) };
}

/** Parse `Duration: HH:MM:SS.xx` from ffmpeg's stderr into whole seconds (>=1). */
function parseDurationSec(ffmpegStderr: string): number {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(ffmpegStderr);
  if (!match) {
    return 1;
  }
  const [, h, m, s] = match;
  const seconds = Number(h) * 3600 + Number(m) * 60 + Number(s);
  return Math.max(1, Math.round(seconds));
}

/** Start listening on an ephemeral loopback port; resolve with the port number. */
function listen(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (address && typeof address === "object") {
        resolve(address.port);
      } else {
        reject(new Error("Could not determine the demo server port."));
      }
    });
  });
}

/** Close the server, resolving once it has stopped accepting connections. */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
