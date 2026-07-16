import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";

import {
  makeProofId,
  renderIndexHtml,
  writeShareableProof,
  SHARE_INDEX_FILENAME,
  SHARE_VIDEO_FILENAME,
} from "../dist/share.js";
import { proofcastDemo } from "../dist/cli.js";

/** MP4 files carry an "ftyp" box; bytes 4..8 spell it out. */
function looksLikeMp4(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp";
}

// ── writeShareableProof (unit) ────────────────────────────────────────────────

test("writeShareableProof builds a self-contained proof-<id>/ (index.html + proof.mp4)", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "proofcast-share-"));
  try {
    const video = Buffer.from("ftypMP4-PROOF-BYTES");
    const result = await writeShareableProof({
      feature: "My signup page",
      status: "passed",
      durationMs: 4321,
      video,
      outDir,
      timestamp: new Date("2026-07-16T08:20:24Z"),
      id: "test-id",
    });

    assert.ok(result.dir.endsWith("proof-test-id"), "folder is named proof-<id>");
    assert.ok(result.indexPath.endsWith(SHARE_INDEX_FILENAME));
    assert.ok(result.videoPath.endsWith(SHARE_VIDEO_FILENAME));
    assert.ok(existsSync(result.indexPath), "index.html was written");
    assert.deepEqual(readFileSync(result.videoPath), video, "the MP4 travels with the folder");

    const html = readFileSync(result.indexPath, "utf8");
    assert.match(html, /src="proof\.mp4"/, "video is referenced by a RELATIVE path (file:// + static host)");
    assert.match(html, /My signup page/, "shows the feature");
    assert.match(html, /PASSED/, "shows the status");
    assert.match(html, /4\.3s/, "shows the duration");
    assert.match(html, /2026-07-16 08:20:24 UTC/, "shows the timestamp");
    assert.match(html, /github\.com\/guillaumeCode2012\/proofcast/, "discreet ProofCast branding + repo link");

    // Self-contained: no external stylesheet/script/CDN is ever fetched.
    assert.doesNotMatch(html, /<script[^>]+\bsrc=/i, "no external script");
    assert.doesNotMatch(html, /<link\b/i, "no external stylesheet");
    assert.doesNotMatch(html, /src="https?:/i, "no remotely-loaded asset");
    assert.doesNotMatch(html, /cdn/i, "no CDN dependency");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("writeShareableProof rejects an empty video", async () => {
  await assert.rejects(
    () => writeShareableProof({ feature: "x", status: "passed", durationMs: 1, video: Buffer.alloc(0), outDir: tmpdir() }),
    /non-empty proof video/i,
  );
});

test("renderIndexHtml escapes the feature (no HTML injection)", () => {
  const html = renderIndexHtml({
    feature: '<img src=x onerror=alert(1)>',
    status: "passed",
    durationMs: 1000,
    timestamp: new Date("2026-07-16T00:00:00Z"),
    videoFile: "proof.mp4",
    sizeBytes: 1024,
  });
  assert.doesNotMatch(html, /<img src=x onerror/, "the raw tag must never be injected");
  assert.match(html, /&lt;img src=x onerror/, "it is HTML-escaped instead");
});

test("makeProofId is filesystem-safe (no ':' or '.')", () => {
  const id = makeProofId(new Date("2026-07-16T08:20:24.500Z"));
  assert.doesNotMatch(id, /[:.]/, "safe on Windows (no colons/dots)");
  assert.match(id, /^2026-07-16_08-20-24-[0-9a-f]{6}$/);
});

// ── proofcast demo --share / --open (CLI wiring) ──────────────────────────────

test("proofcast demo --share: writes the shareable folder, reports sharePath, and it PLAYS", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "proofcast-share-cli-"));
  const out = [];
  try {
    const code = await proofcastDemo(["--share", outDir], {
      stdout: (line) => out.push(line),
      stderr: () => {},
      now: () => Date.now(),
    });

    assert.equal(code, 0, `demo --share should exit 0; stdout=${out.join("\n")}`);
    const json = JSON.parse(out[0]);
    assert.equal(json.success, true);
    assert.ok(json.sharePath && json.sharePath.endsWith(SHARE_INDEX_FILENAME), "reports sharePath → index.html");
    assert.ok(existsSync(json.sharePath), "index.html exists");

    const videoPath = join(json.sharePath, "..", SHARE_VIDEO_FILENAME);
    assert.ok(looksLikeMp4(readFileSync(videoPath)), "a real MP4 sits next to index.html");

    // The whole point: it renders and the video is actually decodable in a browser.
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const consoleErrors = [];
      page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
      await page.goto(pathToFileURL(json.sharePath).href, { waitUntil: "load" });
      await page.waitForFunction(
        () => {
          const v = document.querySelector("video");
          return !!v && v.readyState >= 2 && v.videoWidth > 0;
        },
        { timeout: 15000 },
      );
      const width = await page.evaluate(() => document.querySelector("video").videoWidth);
      assert.ok(width > 0, "the proof video decodes and plays from file://");
      assert.deepEqual(consoleErrors, [], "no console errors → nothing external is fetched");
      assert.match(await page.locator("body").innerText(), /PASSED/, "the ProofReport is displayed");
    } finally {
      await browser.close();
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("proofcast demo --open implies --share and opens the reported page (no real browser)", async () => {
  const opened = [];
  const out = [];
  const code = await proofcastDemo(["--open"], {
    // Stub the heavy bits so this stays a fast unit test of the flag wiring.
    proveDemo: async () => ({ success: true, video: Buffer.from("ftyp-demo"), durationMs: 3 }),
    writeShare: async ({ outDir }) => ({
      id: "x",
      dir: join(outDir, "proof-x"),
      indexPath: join(outDir, "proof-x", "index.html"),
      videoPath: join(outDir, "proof-x", "proof.mp4"),
    }),
    writeProof: async () => {},
    openPath: async (target) => void opened.push(target),
    stdout: (line) => out.push(line),
    stderr: () => {},
    now: () => 0,
  });

  assert.equal(code, 0);
  const json = JSON.parse(out[0]);
  assert.ok(json.sharePath.endsWith("index.html"), "--open implied --share");
  assert.equal(opened.length, 1, "the page was opened");
  assert.equal(opened[0], json.sharePath, "…and it opened exactly the reported sharePath");
});
