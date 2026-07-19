import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";

import { proofcastDemo, DEMO_PROOF_FILENAME } from "../dist/cli.js";
import { proveCode, spawnServerProcess, waitForPort } from "../dist/prover.js";
import { smartDemo } from "../dist/video.js";

/**
 * End-to-end test for the three shipped examples (the README's "See it work"
 * gallery), covering the three shapes ProofCast proves: auth, payment, and plain
 * stateful CRUD.
 *
 * It exercises the REAL pipeline — the real prover boots each real example server
 * (Node's built-in http, zero dependencies) and drives it in a REAL Chromium,
 * recording a REAL MP4 via ffmpeg. Nothing is mocked and nothing hits the
 * network: the examples have no dependencies, so they are spawned directly with
 * `node server.js` (no `npm install`, no registry). This is the CI guard that
 * keeps every `proofcast run ./examples/<name>` in the README honest.
 */

/**
 * The three committed examples (tests run with cwd = repo root). Each `drive`
 * asserts the feature ACTUALLY moved — not merely that the page loaded — using
 * `smartDemo`, the exact driver `proofcast run` uses by default with the exact
 * default form data. If a change ever made the driver scroll past one of these
 * instead of driving it, these assertions fail.
 */
const EXAMPLES = [
  {
    name: "signup",
    what: "creates the account",
    drive: async (page) => {
      assert.equal(await page.locator("#email").inputValue(), "demo.user@example.com", "email typed");
      assert.match(
        await page.locator("#result").textContent(),
        /Account created for demo\.user@example\.com/,
        "submitting the signup form must create the account",
      );
    },
  },
  {
    name: "checkout",
    what: "pays with the test card",
    drive: async (page) => {
      assert.equal(await page.locator("#cardnumber").inputValue(), "4242 4242 4242 4242", "test card typed");
      // The payment is deliberately async (a brief "processing" step), so wait
      // for the settled success state rather than sampling mid-flight.
      await page.locator(".success h2").waitFor({ timeout: 5_000 });
      assert.match(
        await page.locator(".success h2").textContent(),
        /Payment successful/,
        "clicking Pay must complete the payment",
      );
      assert.match(
        await page.locator(".success .order").textContent(),
        /Order #\d+/,
        "a real order number must be issued",
      );
    },
  },
  {
    name: "todo",
    what: "adds the task to the list",
    drive: async (page) => {
      assert.equal(await page.locator("#list li").count(), 1, "the task must be added to the list");
      assert.equal(
        await page.locator("#list li span").first().textContent(),
        "Ship the Q3 release notes",
        "the typed task must appear in the list",
      );
      assert.equal(
        await page.locator("#count").textContent(),
        "1 open · 1 total",
        "the counter must reflect the new task",
      );
    },
  },
];

/** Absolute path to a committed example directory. */
function exampleDir(name) {
  return join(process.cwd(), "examples", name);
}

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

/**
 * Spawn an example the way local mode does — `node server.js` on `port` — and
 * wait for it. Uses `process.execPath` (not `npm`) so this works identically on
 * Windows, macOS and Linux with no shell involved.
 */
async function startExample(dir, port) {
  const handle = await spawnServerProcess(dir, port, {
    command: process.execPath,
    args: ["server.js"],
  });
  await waitForPort(port, 15_000);
  return handle;
}

for (const example of EXAMPLES) {
  test(`examples/${example.name}: the feature actually works — it ${example.what} (real Chromium)`, async () => {
    const port = await freePort();
    const server = await startExample(exampleDir(example.name), port);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const consoleErrors = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("pageerror", (err) => consoleErrors.push(err.message));

      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });

      // The SAME adaptive driver the prover runs in the real pipeline, with the
      // same default form data — so this test fails for the same reasons a real
      // `proofcast run` would.
      await smartDemo(page);
      await example.drive(page);

      assert.deepEqual(consoleErrors, [], "a shipped example must run clean in the console");
    } finally {
      await browser.close();
      await server.stop();
    }
  });

  test(`examples/${example.name}: the real prover reports success:true and a genuine MP4 (no network)`, async () => {
    const port = await freePort();

    const report = await proveCode(exampleDir(example.name), {
      port,
      execution: "local",
      // Zero-dependency example ⇒ skip `npm install` (nothing to fetch) and boot
      // it directly. Everything else — the browser drive, error capture, ffmpeg
      // transcode — is the real prover, unmocked.
      deps: {
        startServer: (dir, p) => startExample(dir, p),
      },
    });

    assert.equal(report.success, true, `expected a passing proof, got: ${JSON.stringify(report.errors)}`);
    assert.equal(report.errors, undefined, "a healthy run reports no errors");
    assert.ok(looksLikeMp4(report.video), "the proof must be a real MP4 (ftyp box present)");
    assert.ok(report.video.length > 0, "the proof video must be non-empty");
    assert.equal(typeof report.sourceHash, "string", "a passing proof is bound to the source it proved");
    assert.equal(typeof report.durationMs, "number");
  });
}

test("proofcast demo: bundled example → real MP4 in an empty out dir, exit 0 (no Docker, no API key)", async () => {
  // The whole point: from a folder with NO user files, `demo` resolves the example
  // bundled in the package, proves it locally in a real browser, and writes a real
  // MP4. This is the true end-to-end path a first-time `npx proofcast demo` runs.
  const outDir = mkdtempSync(join(tmpdir(), "proofcast-demo-out-"));
  const out = [];
  try {
    const code = await proofcastDemo([outDir], {
      stdout: (line) => out.push(line),
      stderr: () => {},
      now: () => Date.now(),
    });

    assert.equal(code, 0, `demo should exit 0; stdout=${out.join("\n")}`);
    assert.equal(out.length, 1, "exactly one JSON line on stdout");
    const json = JSON.parse(out[0]);
    assert.equal(json.success, true);
    assert.ok(json.proofPath.endsWith(DEMO_PROOF_FILENAME), "reports the demo proof path");

    const buf = readFileSync(json.proofPath);
    assert.ok(looksLikeMp4(buf), "the demo wrote a real MP4 (ftyp box present)");
    assert.ok(buf.length > 0, "the demo MP4 is non-empty");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
