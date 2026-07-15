import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  proveCode,
  BootFailure,
  classifyBootLogs,
  classifyBrowserErrors,
  startSandboxServer,
  spawnServerProcess,
} from "../dist/prover.js";

const FAKE_DIR = join(tmpdir(), "proofcast-prove-fake-project");

/** A fake server handle that records how many times it was stopped. */
function fakeServer() {
  const handle = { port: 3000, stopCalls: 0, stop: async () => void handle.stopCalls++ };
  return handle;
}

/** A fake dockerode client + container that records how it was driven (mirrors sandbox.test). */
function mockDocker() {
  const container = {
    id: "fake-container-id",
    started: false,
    stopCalls: [],
    removeCalls: [],
    start: async () => void (container.started = true),
    stop: async (opts) => void container.stopCalls.push(opts),
    remove: async (opts) => void container.removeCalls.push(opts),
  };
  const docker = { createContainer: async () => container };
  return { docker, container };
}

const noopCheck = () => {};

// ── proveCode ───────────────────────────────────────────────────────────────

test("proveCode returns success + the proof video when everything passes", async () => {
  const server = fakeServer();
  const report = await proveCode(FAKE_DIR, {
    deps: {
      startServer: async () => server,
      runChecks: async () => ({ errors: [], video: Buffer.from("MP4-PROOF") }),
    },
  });

  assert.equal(report.success, true);
  assert.equal(report.video?.toString(), "MP4-PROOF");
  assert.equal(report.errors, undefined, "no errors on success");
  assert.equal(typeof report.durationMs, "number");
  assert.ok(report.durationMs >= 0);
  assert.equal(server.stopCalls, 1, "the server is always stopped, even on success");
});

test("proveCode reports BUILD_FAILED with no retry and never drives the browser", async () => {
  let startCalls = 0;
  let checkCalls = 0;

  const report = await proveCode(FAKE_DIR, {
    deps: {
      startServer: async () => {
        startCalls++;
        throw new BootFailure("BUILD_FAILED", "The project never became ready.", "src/app.ts:1 error TS1005");
      },
      runChecks: async () => {
        checkCalls++;
        return { errors: [] };
      },
    },
  });

  assert.equal(report.success, false);
  assert.equal(report.errors?.length, 1);
  assert.equal(report.errors[0].type, "BUILD_FAILED");
  assert.match(report.errors[0].details, /error TS1005/, "keeps the build log in details");
  assert.equal(startCalls, 1, "single-shot: booted exactly once (no internal retry)");
  assert.equal(checkCalls, 0, "a boot failure never reaches the browser step");
});

test("proveCode maps a captured console error to CONSOLE_ERROR with the logs in details", async () => {
  const server = fakeServer();
  const report = await proveCode(FAKE_DIR, {
    deps: {
      startServer: async () => server,
      runChecks: async () => ({ errors: ["console.error: Uncaught ReferenceError: foo is not defined"] }),
    },
  });

  assert.equal(report.success, false);
  assert.equal(report.errors[0].type, "CONSOLE_ERROR");
  assert.match(report.errors[0].details, /Uncaught ReferenceError: foo is not defined/);
  assert.equal(server.stopCalls, 1);
});

test("proveCode maps page/HTTP errors to RUNTIME_ERROR", async () => {
  const report = await proveCode(FAKE_DIR, {
    deps: {
      startServer: async () => fakeServer(),
      runChecks: async () => ({ errors: ["http 500 http://localhost:3000/api", "pageerror: boom"] }),
    },
  });
  assert.equal(report.success, false);
  assert.equal(report.errors[0].type, "RUNTIME_ERROR");
});

test("proveCode always stops the server, even when runChecks throws mid-prove", async () => {
  const server = fakeServer();
  const report = await proveCode(FAKE_DIR, {
    deps: {
      startServer: async () => server,
      runChecks: async () => {
        throw new Error("CRITICAL failure while driving the demo");
      },
    },
  });

  assert.equal(report.success, false, "an unexpected throw becomes a failed report, not a crash");
  assert.equal(report.errors[0].type, "RUNTIME_ERROR");
  assert.match(report.errors[0].message, /CRITICAL failure while driving the demo/);
  assert.equal(server.stopCalls, 1, "the server was still torn down");
});

test("proveCode tears the sandbox down through the REAL stopSandbox on a mid-prove throw", async () => {
  const { container } = mockDocker();
  const report = await proveCode(FAKE_DIR, {
    deps: {
      // A handle whose stop() goes through the real stopSandbox (imported by prover).
      startServer: async () => {
        const { stopSandbox } = await import("../dist/sandbox.js");
        return { port: 3000, stop: async () => stopSandbox(container) };
      },
      runChecks: async () => {
        throw new Error("boom mid-demo");
      },
    },
  });

  assert.equal(report.success, false);
  assert.equal(container.stopCalls.length, 1, "container stopped despite the exception");
  assert.equal(container.removeCalls.length, 1, "container removed despite the exception");
});

test("proveCode validates its input", async () => {
  await assert.rejects(() => proveCode(""), TypeError);
  await assert.rejects(() => proveCode("   "), TypeError);
});

test("proveCode fails CLEARLY on a missing directory (no cryptic spawn ENOENT on Windows)", async () => {
  // A real user hit `spawn C:\WINDOWS\system32\cmd.exe ENOENT` by pointing `run`
  // at a folder that doesn't exist (npm is spawned through a shell on Windows, so
  // a missing cwd surfaces as ENOENT on the shell). We must catch that up front.
  const missing = join(tmpdir(), `proofcast-missing-${Date.now()}`);
  const report = await proveCode(missing, { execution: "local" });

  assert.equal(report.success, false);
  assert.equal(report.errors[0].type, "INSTALL_FAILED");
  assert.match(report.errors[0].message, /introuvable|n'existe pas|not found/i);
  assert.doesNotMatch(report.errors[0].message ?? "", /ENOENT|cmd\.exe/i, "no cryptic spawn error leaks out");
});

// ── startSandboxServer (mock dockerode) ─────────────────────────────────────

test("startSandboxServer classifies a build failure from container logs (mock dockerode)", async () => {
  const { docker, container } = mockDocker();

  await assert.rejects(
    () =>
      startSandboxServer(FAKE_DIR, 8080, {
        docker,
        checkDocker: noopCheck,
        // The port never opens…
        waitForPort: async () => {
          throw new Error("not reachable");
        },
        // …and the logs show the build (not install) phase failed.
        readLogs: async () => "npm install\nok\nnpm run build\n> tsc\nsrc/x.ts: error TS2322",
        readyTimeoutMs: 10,
      }),
    (err) => {
      assert.ok(err instanceof BootFailure, "throws a BootFailure");
      assert.equal(err.proofType, "BUILD_FAILED");
      assert.match(err.details, /error TS2322/);
      return true;
    },
  );

  assert.equal(container.stopCalls.length, 1, "the half-booted container was stopped");
  assert.equal(container.removeCalls.length, 1, "…and removed — nothing leaks");
});

test("startSandboxServer flags an install-phase failure as INSTALL_FAILED", async () => {
  const { docker } = mockDocker();
  await assert.rejects(
    () =>
      startSandboxServer(FAKE_DIR, 8081, {
        docker,
        checkDocker: noopCheck,
        waitForPort: async () => {
          throw new Error("not reachable");
        },
        readLogs: async () => "npm install\nnpm error code E404\nnpm error 404 Not Found",
        readyTimeoutMs: 10,
      }),
    (err) => {
      assert.equal(err.proofType, "INSTALL_FAILED");
      return true;
    },
  );
});

// ── classifyBootLogs ────────────────────────────────────────────────────────

test("classifyBootLogs distinguishes install / build / runtime phases", () => {
  assert.equal(classifyBootLogs("npm error code E404\nnpm error 404 Not Found"), "INSTALL_FAILED");
  assert.equal(classifyBootLogs("added 42 packages\nnpm run build\n> tsc\nerror TS2554"), "BUILD_FAILED");
  assert.equal(
    classifyBootLogs("npm run build\ntsc ok\nnpm run start\nlistening on 3000\nUncaught at runtime"),
    "RUNTIME_ERROR",
  );
  assert.equal(classifyBootLogs(""), "INSTALL_FAILED", "empty logs default to the earliest phase");
});

// ── classifyBrowserErrors ───────────────────────────────────────────────────

test("classifyBrowserErrors groups by type and keeps the raw lines in details", () => {
  const out = classifyBrowserErrors([
    "console.error: A",
    "console.error: B",
    "pageerror: C",
    "http 502 http://x",
  ]);
  const console = out.find((e) => e.type === "CONSOLE_ERROR");
  const runtime = out.find((e) => e.type === "RUNTIME_ERROR");
  assert.ok(console && runtime, "one grouped error per type");
  assert.match(console.details, /console\.error: A/);
  assert.match(console.details, /console\.error: B/);
  assert.match(runtime.details, /pageerror: C/);
  assert.match(runtime.details, /http 502/);
});

test("classifyBrowserErrors: a single error puts the real line in the message", () => {
  const [only] = classifyBrowserErrors(["console.error: single boom"]);
  assert.equal(only.type, "CONSOLE_ERROR");
  assert.equal(only.message, "console.error: single boom");
});

test("classifyBrowserErrors: no errors → empty array", () => {
  assert.deepEqual(classifyBrowserErrors([]), []);
});

// ── spawnServerProcess (real child process) ─────────────────────────────────

test("spawnServerProcess starts a real child and stop() actually kills it (PID before/after)", async () => {
  // A real long-running Node process stands in for a dev server.
  const handle = await spawnServerProcess(process.cwd(), 0, {
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000000)"],
  });

  assert.ok(typeof handle.pid === "number", "has a real PID");
  assert.doesNotThrow(() => process.kill(handle.pid, 0), "process is alive before stop()");

  await handle.stop();
  await waitUntilDead(handle.pid, 3000);
  assert.throws(() => process.kill(handle.pid, 0), "process is gone after stop()");

  // stop() is idempotent — a second call must not throw.
  await handle.stop();
});

/** Poll `process.kill(pid, 0)` until it throws (process gone) or the deadline. */
async function waitUntilDead(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH — the process is gone
    }
    if (Date.now() > deadline) throw new Error(`PID ${pid} still alive after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
