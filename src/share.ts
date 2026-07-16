/**
 * ProofCast shareable proofs.
 *
 * Turns a successful proof (an MP4 + its typed report) into a self-contained,
 * portable folder — `proof-<id>/` holding an `index.html` that plays the video and
 * displays the report. It has NO backend, NO account, NO network call, and NO
 * external CDN: the page works BOTH by opening `index.html` directly (file://) AND
 * when the folder is dropped onto any static host. The MP4 is referenced by a
 * relative path so it travels with the folder.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Repository the discreet branding links to. */
export const PROOFCAST_REPO_URL = "https://github.com/guillaumeCode2012/proofcast";

/** Video filename inside the share folder (referenced relatively by index.html). */
export const SHARE_VIDEO_FILENAME = "proof.mp4";

/** Entry-page filename inside the share folder. */
export const SHARE_INDEX_FILENAME = "index.html";

/** Everything needed to render a shareable proof folder. */
export interface ShareableProofInput {
  /** Human label of what was proven (a feature description, a project, an example). */
  feature: string;
  /** Outcome shown on the page. Share folders are produced on success, so normally "passed". */
  status: "passed" | "failed";
  /** Wall-clock duration of the proof, in milliseconds. */
  durationMs: number;
  /** Repair attempts (from `generate`); omitted for `run`/`demo`. */
  attempts?: number;
  /** The proof video (MP4). Must be non-empty. */
  video: Buffer;
  /** Directory the `proof-<id>/` folder is created inside. */
  outDir: string;
  /** Generation time (default: now). */
  timestamp?: Date;
  /** Explicit folder id (mainly for deterministic tests). Default: timestamp + random. */
  id?: string;
}

/** Absolute paths produced by {@link writeShareableProof}. */
export interface ShareableProofResult {
  id: string;
  /** The `proof-<id>/` folder. */
  dir: string;
  /** The shareable `index.html` (this is what `sharePath` points at). */
  indexPath: string;
  /** The copied `proof.mp4`. */
  videoPath: string;
}

/**
 * Build a self-contained, shareable proof folder and return its paths.
 *
 * @throws if the video is empty (there is nothing to prove).
 */
export async function writeShareableProof(input: ShareableProofInput): Promise<ShareableProofResult> {
  if (!input.video || input.video.length === 0) {
    throw new Error("A non-empty proof video is required to build a shareable proof.");
  }

  const timestamp = input.timestamp ?? new Date();
  const id = input.id ?? makeProofId(timestamp);
  const dir = resolve(input.outDir, `proof-${id}`);
  await mkdir(dir, { recursive: true });

  const videoPath = join(dir, SHARE_VIDEO_FILENAME);
  await writeFile(videoPath, input.video);

  const indexPath = join(dir, SHARE_INDEX_FILENAME);
  const html = renderIndexHtml({
    feature: input.feature,
    status: input.status,
    durationMs: input.durationMs,
    attempts: input.attempts,
    timestamp,
    videoFile: SHARE_VIDEO_FILENAME,
    sizeBytes: input.video.length,
  });
  await writeFile(indexPath, html, "utf8");

  return { id, dir, indexPath, videoPath };
}

/** A filesystem-safe, roughly-sortable folder id: `2026-07-16_15-30-45-a1b2c3`. */
export function makeProofId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

interface IndexHtmlData {
  feature: string;
  status: "passed" | "failed";
  durationMs: number;
  attempts?: number;
  timestamp: Date;
  videoFile: string;
  sizeBytes: number;
}

/**
 * Render the self-contained `index.html`. All CSS/JS is inline and the only asset
 * is the sibling MP4 (relative src) — nothing is fetched from the network, so it
 * renders identically from `file://` and from a static host.
 */
export function renderIndexHtml(data: IndexHtmlData): string {
  const passed = data.status === "passed";
  const seconds = data.durationMs / 1000;
  const duration = seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString();
  const rows: Array<[string, string]> = [
    ["Feature", esc(data.feature)],
    ["Status", `<span class="badge ${passed ? "ok" : "fail"}">${passed ? "PASSED" : "FAILED"}</span>`],
    ["Duration", `${esc(duration)}s`],
    ["Recorded", esc(formatTimestamp(data.timestamp))],
  ];
  if (typeof data.attempts === "number") {
    rows.push(["Attempts", esc(String(data.attempts))]);
  }
  rows.push(["Video size", `${Math.max(1, Math.round(data.sizeBytes / 1024))} KB`]);

  const tableRows = rows
    .map(([k, v]) => `        <tr><th>${esc(k)}</th><td>${v}</td></tr>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ProofCast — proof of "${esc(data.feature)}"</title>
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 32px 16px;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(1100px 520px at 50% -8%, #17233b, #0b1120);
    color: #e2e8f0; display: flex; flex-direction: column; align-items: center;
  }
  .wrap { width: 100%; max-width: 860px; }
  header { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
  .logo {
    width: 26px; height: 26px; border-radius: 7px; flex: none;
    background: linear-gradient(135deg, #38bdf8, #22d3ee);
    display: grid; place-items: center; color: #06263a; font-weight: 800; font-size: 15px;
  }
  header .name { font-weight: 700; letter-spacing: .2px; }
  header .tag { color: #94a3b8; font-size: .85rem; margin-left: auto; }
  .card {
    background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 16px; overflow: hidden; box-shadow: 0 24px 70px rgba(0,0,0,0.45);
  }
  .videowrap { background: #000; }
  video { display: block; width: 100%; max-height: 62vh; background: #000; }
  .meta { padding: 20px 22px; }
  h1 { margin: 0 0 4px; font-size: 1.15rem; }
  .sub { margin: 0 0 16px; color: #94a3b8; font-size: .88rem; }
  table { width: 100%; border-collapse: collapse; font-size: .92rem; }
  th, td { text-align: left; padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.06); vertical-align: top; }
  th { color: #94a3b8; font-weight: 500; width: 130px; white-space: nowrap; }
  tr:last-child th, tr:last-child td { border-bottom: 0; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: .78rem; font-weight: 700; letter-spacing: .3px; }
  .badge.ok { background: rgba(74,222,128,0.15); color: #4ade80; border: 1px solid rgba(74,222,128,0.35); }
  .badge.fail { background: rgba(248,113,113,0.15); color: #f87171; border: 1px solid rgba(248,113,113,0.35); }
  footer { margin-top: 16px; text-align: center; color: #64748b; font-size: .82rem; }
  footer a { color: #38bdf8; text-decoration: none; }
  footer a:hover { text-decoration: underline; }
  @media (prefers-color-scheme: light) {
    body { background: radial-gradient(1100px 520px at 50% -8%, #eaf2ff, #f6f8fc); color: #0f172a; }
    .card { background: #fff; border-color: #e2e8f0; box-shadow: 0 24px 70px rgba(15,23,42,0.12); }
    .sub, th, header .tag { color: #64748b; }
    th, td { border-color: #eef2f7; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="logo">P</div>
      <div class="name">ProofCast</div>
      <div class="tag">shareable proof</div>
    </header>

    <div class="card">
      <div class="videowrap">
        <video src="${esc(data.videoFile)}" controls autoplay muted loop playsinline preload="metadata"></video>
      </div>
      <div class="meta">
        <h1>Proof of "${esc(data.feature)}"</h1>
        <p class="sub">A real browser session, recorded — watch it, don't take our word for it.</p>
        <table>
${tableRows}
        </table>
      </div>
    </div>

    <footer>
      Generated by <a href="${PROOFCAST_REPO_URL}" target="_blank" rel="noopener">ProofCast</a>
      — proof before deploy.
    </footer>
  </div>
</body>
</html>`;
}

/** Escape a string for safe interpolation into HTML text/attributes. */
function esc(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Human-readable UTC timestamp, e.g. `2026-07-16 15:30:45 UTC`. */
function formatTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/**
 * Open a file/URL in the user's default browser, cross-platform and best-effort:
 * a missing opener (e.g. headless Linux without `xdg-open`) must NEVER crash the
 * CLI. On Windows we go through `cmd /s /c start "" "<target>"` with verbatim args
 * (the robust incantation for paths with spaces); macOS uses `open`, Linux
 * `xdg-open`. Fire-and-forget: the child is detached and unref'd.
 */
export function openInBrowser(target: string, platform: NodeJS.Platform = process.platform): void {
  let command: string;
  let args: string[];
  let windowsVerbatimArguments = false;

  if (platform === "win32") {
    command = process.env.ComSpec || "cmd.exe";
    // `start` is a cmd builtin; the empty "" is the (required) window title.
    args = ["/s", "/c", `start "" "${target}"`];
    windowsVerbatimArguments = true;
  } else if (platform === "darwin") {
    command = "open";
    args = [target];
  } else {
    command = "xdg-open";
    args = [target];
  }

  try {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
      windowsVerbatimArguments,
    });
    // Swallow "opener not found" etc. — opening is a convenience, never a failure.
    child.once("error", () => {});
    child.unref();
  } catch {
    /* best-effort: never let opening a browser break the command */
  }
}
