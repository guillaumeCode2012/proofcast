import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { join } from "node:path";

import { chromium } from "playwright";

import { proveCode, spawnServerProcess, waitForPort } from "../dist/prover.js";
import { autoFillDemoForm } from "../dist/video.js";

/**
 * End-to-end test for the "2-minute local trial" (examples/signup).
 *
 * It exercises the REAL pipeline — the real prover boots the real example server
 * (Node's built-in http, zero dependencies) and drives it in a REAL Chromium,
 * recording a REAL MP4 via ffmpeg. Nothing is mocked and nothing hits the
 * network: the example has no dependencies, so it is spawned directly with
 * `node server.js` (no `npm install`, no registry). This is the CI guard that
 * keeps `proofcast run ./examples/signup` (a.k.a. `npm run demo`) honest.
 */

/** The committed example directory (tests run with cwd = repo root). */
const EXAMPLE_DIR = join(process.cwd(), "examples", "signup");

/** Ask the OS for a free loopback port so parallel runs never collide. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** MP4 files carry an "ftyp" box; bytes 4..8 spell it out. */
function looksLikeMp4(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp";
}

/** Spawn the example the way local mode does — `node server.js` on `port` — and wait for it. */
async function startExample(dir, port) {
  const handle = await spawnServerProcess(dir, port, {
    command: process.execPath,
    args: ["server.js"],
  });
  await waitForPort(port, 15_000);
  return handle;
}

test("examples/signup: the signup feature actually works (real Chromium)", async () => {
  const port = await freePort();
  const server = await startExample(EXAMPLE_DIR, port);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });

    // Drive it with the SAME form-filler the prover uses in the real pipeline.
    await autoFillDemoForm(page, { email: "trial@example.com", password: "S3curePass!" });

    assert.equal(await page.locator("#email").inputValue(), "trial@example.com");
    assert.match(
      await page.locator("#result").textContent(),
      /Account created for trial@example\.com/,
      "submitting the signup form must create the account (no bug, no console error)",
    );
  } finally {
    await browser.close();
    await server.stop();
  }
});

test("examples/signup: the real prover proves it and records a genuine MP4 (no network)", async () => {
  const port = await freePort();

  const report = await proveCode(EXAMPLE_DIR, {
    port,
    execution: "local",
    // Zero-dependency example ⇒ skip `npm install` (nothing to fetch) and boot it
    // directly. Everything else — the browser drive, error capture, ffmpeg
    // transcode — is the real prover, unmocked.
    deps: {
      startServer: (dir, p) => startExample(dir, p),
    },
  });

  assert.equal(report.success, true, `expected a passing proof, got: ${JSON.stringify(report.errors)}`);
  assert.equal(report.errors, undefined, "a healthy run reports no errors");
  assert.ok(looksLikeMp4(report.video), "the proof must be a real MP4 (ftyp box present)");
  assert.ok(report.video.length > 0, "the proof video must be non-empty");
  assert.equal(typeof report.durationMs, "number");
});
