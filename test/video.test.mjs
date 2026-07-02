import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { chromium } from "playwright";

import {
  autoFillDemoForm,
  hasDemoBeenGenerated,
  recordDemo,
  resetDemoSession,
  runDemoActions,
  smartDemo,
} from "../dist/video.js";

/** A tiny self-contained signup page whose submit handler reports success. */
const LOGIN_HTML = `<!doctype html><html><body>
<form id="f">
  <input type="email" id="email" name="email" placeholder="Email">
  <input type="password" id="password" name="password" placeholder="Password">
  <button type="submit">Create account</button>
</form>
<div id="result"></div>
<script>
  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    var em = document.getElementById('email').value;
    var pw = document.getElementById('password').value;
    if (em && pw) document.getElementById('result').textContent = 'Account created for ' + em;
  });
</script>
</body></html>`;

/** A tall landing page so scrolling is observable. */
const TALL_HTML = `<!doctype html><html><body style="margin:0">
<div style="height:3000px;background:linear-gradient(#ffffff,#000000)"></div>
<div id="footer">bottom</div>
</body></html>`;

function isPortClosed(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

/** MP4 files carry an "ftyp" box; bytes 4..8 spell it out. */
function looksLikeMp4(buffer) {
  return buffer.length > 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp";
}

test("runDemoActions drives a login feature (fill + click → account created)", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(LOGIN_HTML);

    await runDemoActions(page, [
      { type: "fill", selector: "#email", value: "carol@example.com" },
      { type: "fill", selector: "#password", value: "pw999999" },
      { type: "click", selector: "button[type=submit]" },
    ]);

    assert.equal(
      await page.locator("#result").textContent(),
      "Account created for carol@example.com",
    );
  } finally {
    await browser.close();
  }
});

test("runDemoActions scrolls a landing page", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(TALL_HTML);

    assert.equal(await page.evaluate(() => window.scrollY), 0);
    await runDemoActions(page, [{ type: "scroll", steps: 3 }]);
    const y = await page.evaluate(() => window.scrollY);
    assert.ok(y > 0, `page should have scrolled down, got scrollY=${y}`);
  } finally {
    await browser.close();
  }
});

test("smartDemo adapts: fills an auth form (page with a password field)", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(LOGIN_HTML);
    await smartDemo(page, { email: "eve@example.com", password: "pw000000" });
    assert.equal(
      await page.locator("#result").textContent(),
      "Account created for eve@example.com",
      "an auth form (password field) should be filled and submitted",
    );
  } finally {
    await browser.close();
  }
});

test("smartDemo adapts: scrolls a landing page (no auth form)", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(TALL_HTML);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    await smartDemo(page);
    assert.ok(
      (await page.evaluate(() => window.scrollY)) > 0,
      "a landing page (no password field) should be scrolled",
    );
  } finally {
    await browser.close();
  }
});

test("autoFillDemoForm types email + password and submits (account created)", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(LOGIN_HTML);

    await autoFillDemoForm(page, { email: "alice@example.com", password: "hunter2!" });

    assert.equal(await page.locator("#email").inputValue(), "alice@example.com");
    assert.equal(await page.locator("#password").inputValue(), "hunter2!");
    assert.equal(
      await page.locator("#result").textContent(),
      "Account created for alice@example.com",
    );
  } finally {
    await browser.close();
  }
});

test("recordDemo records a feature demo (adaptive actions) as MP4", async () => {
  resetDemoSession();
  const result = await recordDemo({
    html: LOGIN_HTML,
    durationMs: 200,
    actions: [
      { type: "fill", selector: "#email", value: "dan@example.com" },
      { type: "fill", selector: "#password", value: "pw123456" },
      { type: "click", selector: "button[type=submit]" },
    ],
  });
  assert.ok(looksLikeMp4(result.video), "should be a real MP4");
  assert.ok(result.sizeBytes > 0);
  assert.ok(result.videoPath.endsWith(".mp4"));
  assert.equal(hasDemoBeenGenerated(), true);
});

test("recordDemo returns a non-empty MP4 buffer and sets the session flag (default scroll)", async () => {
  resetDemoSession();
  assert.equal(hasDemoBeenGenerated(), false);

  let capturedPort;
  const result = await recordDemo({
    durationMs: 400,
    onServerListening: (port) => {
      capturedPort = port;
    },
  });

  assert.ok(Buffer.isBuffer(result.video), "video should be a Buffer");
  assert.ok(result.sizeBytes > 0, "video should be non-empty");
  assert.equal(result.video.length, result.sizeBytes);
  assert.ok(result.videoPath.endsWith(".mp4"), "delivered video should be .mp4");
  assert.ok(result.webmPath.endsWith(".webm"), "intermediate capture should be .webm");
  assert.ok(looksLikeMp4(result.video), "buffer should be a real MP4 (ftyp box present)");

  assert.equal(hasDemoBeenGenerated(), true, "session flag must be set after success");

  assert.ok(
    await isPortClosed(capturedPort),
    "local demo server must be closed after recording",
  );
});

test("resetDemoSession clears the session flag", () => {
  resetDemoSession();
  assert.equal(hasDemoBeenGenerated(), false);
});

test("recordDemo tears down and leaves the flag unset when recording fails", async () => {
  resetDemoSession();

  let capturedPort;
  await assert.rejects(
    recordDemo({
      durationMs: 400,
      onServerListening: (port) => {
        capturedPort = port;
      },
      onPage: async () => {
        throw new Error("boom in scripted interaction");
      },
    }),
    /boom in scripted interaction/,
  );

  assert.equal(hasDemoBeenGenerated(), false, "flag must stay unset on failure");
  assert.ok(
    await isPortClosed(capturedPort),
    "server must be closed even when recording throws",
  );
});

test("recordDemo works again after a failure (no leaked browser or server)", async () => {
  const result = await recordDemo({ durationMs: 400 });
  assert.ok(result.sizeBytes > 0);
  assert.ok(looksLikeMp4(result.video));
  assert.equal(hasDemoBeenGenerated(), true);
});
