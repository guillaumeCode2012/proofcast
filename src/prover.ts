/**
 * ProofCast prover — the pure "test a project, report the result" primitive.
 *
 * {@link proveCode} takes a directory that ALREADY contains code (written by
 * ProofCast's own AI loop), boots it in an isolated Docker sandbox
 * (src/sandbox.ts) — or locally as a fallback — drives it with Playwright while
 * watching for runtime problems, and returns a structured {@link ProofReport}.
 *
 * Hard guarantees:
 *   - It NEVER generates or fixes code, and it imports NO AI SDK, directly or
 *     transitively (only src/sandbox.ts + src/video.ts + node builtins). A run of
 *     the prover can therefore make no LLM/network call by construction.
 *   - It is SINGLE-SHOT: one boot, one test, one report. There is no internal
 *     retry — the caller ({@link executeAndHeal}) owns the "fix → re-run" loop.
 *   - The sandbox/server is ALWAYS torn down in a `finally`, on success, on a
 *     typed failure, and on an unexpected mid-run throw — no container ever leaks.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";

// Type-only imports: playwright (~78 MB) and dockerode are lazy/opaque here.
import type { Browser, BrowserContext } from "playwright";
import type Docker from "dockerode";

import { startSandbox, stopSandbox } from "./sandbox.js";
import { safeHashSourceDir } from "./source-hash.js";
import {
  runDemoActions,
  smartDemo,
  transcodeToMp4,
  type DemoAction,
  type DemoFormData,
} from "./video.js";

/** Default host port the project binds and Playwright connects to. */
export const DEFAULT_PROVE_PORT = 3000;

/**
 * How long to wait for the project's port to accept connections before giving up.
 * The sandbox runs `npm install && npm run build && npm run start`, so first boot
 * can take a while — hence a generous default.
 */
export const DEFAULT_SANDBOX_READY_TIMEOUT_MS = 120_000;

/** Default cap on a host-side `npm install` before it is force-killed (ms). */
export const DEFAULT_INSTALL_TIMEOUT_MS = 4 * 60_000;

/** Grace period between SIGTERM and the SIGKILL fallback when stopping a server (ms). */
export const DEFAULT_KILL_GRACE_MS = 2_000;

/** The four failure classes ProofCast reports for a proven project. */
export type ProofErrorType = "BUILD_FAILED" | "INSTALL_FAILED" | "RUNTIME_ERROR" | "CONSOLE_ERROR";

/** One typed failure in a {@link ProofReport}. */
export interface ProofError {
  type: ProofErrorType;
  message: string;
  /** Stack trace, console logs, container output, etc. */
  details?: string;
}

/** Structured outcome of a single {@link proveCode} run. */
export interface ProofReport {
  success: boolean;
  /** The recorded proof video (MP4). Present only when `success === true`. */
  video?: Buffer;
  /**
   * Deterministic hash of the proven source ({@link hashSourceDir}). Present on
   * success (best-effort — omitted if hashing fails). This is what binds a proof to
   * the exact code it proves so the deploy gate can refuse a changed codebase.
   */
  sourceHash?: string;
  /** Typed failures. Present (non-empty) only when `success === false`. */
  errors?: ProofError[];
  /** Wall-clock duration of the whole prove, in milliseconds. */
  durationMs: number;
}

/** A running server (sandbox container or local process) that can be stopped cleanly. */
export interface ServerHandle {
  /** Host port the server is reachable on. */
  port: number;
  /** OS process id (local mode only; undefined for a container). */
  pid?: number;
  /** Stop the server. Safe to call more than once. */
  stop(): Promise<void>;
}

/** Outcome of driving the running server with Playwright. */
export interface BrowserCheckResult {
  /** Detected runtime problems (console errors, page errors, HTTP >= 500). Empty = healthy. */
  errors: string[];
  /** The recorded proof video (MP4), present only on a healthy run. */
  video?: Buffer;
}

/**
 * Thrown by a `startServer` implementation when the project fails to boot, tagged
 * with the phase it failed in so {@link proveCode} can surface a typed error. The
 * implementation is responsible for tearing down anything it started before it
 * throws — a BootFailure means "nothing is left running".
 */
export class BootFailure extends Error {
  constructor(
    readonly proofType: ProofErrorType,
    message: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = "BootFailure";
  }
}

/** Injectable side-effects for {@link proveCode}. Defaults are the real ones; tests pass fakes. */
export interface ProveDependencies {
  /**
   * Boot the project's server on `port` and resolve once it is reachable. MUST
   * throw {@link BootFailure} (with a phase) on a boot failure, having already
   * cleaned up anything it started.
   */
  startServer: (dirPath: string, port: number) => Promise<ServerHandle>;
  /** Drive `url` with Playwright, returning detected errors and (if healthy) a video. */
  runChecks: (url: string) => Promise<BrowserCheckResult>;
}

export interface ProveCodeOptions {
  /** Host port for the server (default {@link DEFAULT_PROVE_PORT}). */
  port?: number;
  /**
   * Where the project runs: `"docker"` (default, isolated sandbox) or `"local"`
   * (directly on the host — fallback when Docker isn't available). Ignored when a
   * `deps.startServer` override is supplied.
   */
  execution?: "docker" | "local";
  /** Override any subset of the heavy side-effects (real by default). */
  deps?: Partial<ProveDependencies>;
}

/**
 * Prove a project: boot it, drive it, and report — ONCE, with no generation and
 * no retry. The sandbox/server is always torn down before this resolves.
 *
 * @param dirPath  an existing project directory to test.
 * @throws {TypeError} for a blank `dirPath`.
 */
export async function proveCode(dirPath: string, options: ProveCodeOptions = {}): Promise<ProofReport> {
  if (typeof dirPath !== "string" || dirPath.trim().length === 0) {
    throw new TypeError("A non-empty project directory path is required.");
  }

  const start = Date.now();

  // Real boot needs the directory to actually exist. Fail with a CLEAR message
  // rather than a cryptic `spawn … cmd.exe ENOENT` (npm on Windows spawns through
  // a shell, and a missing cwd surfaces as ENOENT on the shell) or a Docker bind
  // error. Skipped when a caller injects its own startServer — it owns the dir
  // semantics (the prover's own unit tests boot a fake, non-existent dir).
  if (!options.deps?.startServer && !(await directoryExists(dirPath))) {
    return failReport(
      [
        {
          type: "INSTALL_FAILED",
          message:
            `Le dossier à prouver est introuvable : ${dirPath}. ` +
            "Vérifie le chemin — ou lance `proofcast demo` pour un essai clé en main, sans aucun fichier.",
        },
      ],
      start,
    );
  }

  const port = options.port ?? DEFAULT_PROVE_PORT;
  const execution = options.execution ?? "docker";
  const startServer =
    options.deps?.startServer ??
    ((dir: string, p: number) => (execution === "local" ? startLocalServer(dir, p) : startSandboxServer(dir, p)));
  const runChecks = options.deps?.runChecks ?? ((url: string) => runBrowserChecks(url));

  let server: ServerHandle | undefined;
  try {
    try {
      server = await startServer(dirPath, port);
    } catch (bootErr) {
      // Boot failed (install/build/runtime). startServer already cleaned up.
      return failReport([toBootError(bootErr)], start);
    }

    const result = await runChecks(`http://localhost:${port}`);
    if (result.errors.length === 0) {
      // Bind the proof to the exact source it just proved (best-effort — a hashing
      // hiccup must never turn a clean proof into a failure; the deploy gate then
      // fails closed on a missing hash). Excludes deps/build output/proof artifacts,
      // so `npm install` / the build during the prove don't shift the hash.
      const sourceHash = await safeHashSourceDir(dirPath);
      return { success: true, video: result.video, sourceHash, durationMs: Date.now() - start };
    }
    return failReport(classifyBrowserErrors(result.errors), start);
  } catch (err) {
    // Unexpected throw AFTER a successful boot (e.g. runChecks blew up). The
    // finally below still tears the server down — nothing leaks.
    return failReport(
      [{ type: "RUNTIME_ERROR", message: `Unexpected error while proving: ${errMessage(err)}`, details: errDetails(err) }],
      start,
    );
  } finally {
    if (server) {
      try {
        await server.stop();
      } catch {
        /* best-effort teardown: a failed stop must not mask the report */
      }
    }
  }
}

/** Build a failed report from typed errors, stamping the elapsed time. */
function failReport(errors: ProofError[], start: number): ProofReport {
  return { success: false, errors, durationMs: Date.now() - start };
}

/** Map a boot failure to a typed {@link ProofError}. */
function toBootError(err: unknown): ProofError {
  if (err instanceof BootFailure) {
    return { type: err.proofType, message: err.message, details: err.details };
  }
  return { type: "RUNTIME_ERROR", message: `Boot failed: ${errMessage(err)}`, details: errDetails(err) };
}

/**
 * Classify Playwright-captured error strings into typed {@link ProofError}s.
 * `console.error:`-prefixed lines are CONSOLE_ERROR; everything else (page errors,
 * HTTP 5xx, navigation failures) is RUNTIME_ERROR. Same-typed lines are grouped so
 * the report carries at most one error per type, with the raw lines in `details`.
 */
export function classifyBrowserErrors(errors: string[]): ProofError[] {
  const consoleErrs = errors.filter((e) => /^console\.error:/i.test(e));
  const runtimeErrs = errors.filter((e) => !/^console\.error:/i.test(e));
  const out: ProofError[] = [];
  if (consoleErrs.length > 0) {
    out.push(groupErrors("CONSOLE_ERROR", "console error", consoleErrs));
  }
  if (runtimeErrs.length > 0) {
    out.push(groupErrors("RUNTIME_ERROR", "runtime error", runtimeErrs));
  }
  return out;
}

/**
 * Fold same-typed Playwright error lines into one {@link ProofError}. `message`
 * leads with the first offending line (so a caller logging just the message still
 * sees the real error), and `details` always carries every captured line.
 */
function groupErrors(type: ProofErrorType, label: string, lines: string[]): ProofError {
  const first = lines[0] ?? "";
  const message = lines.length === 1 ? first : `${lines.length} ${label}s (first: ${first})`;
  return { type, message, details: lines.join("\n") };
}

/**
 * Classify why a sandbox never came up, from its container logs. The container
 * runs `npm install && npm run build && npm run start` (chained with `&&`), so the
 * furthest phase the logs reached tells us where it broke: reached `start` but
 * still failed → RUNTIME_ERROR; reached `build` but never started → BUILD_FAILED;
 * never even reached `build` → INSTALL_FAILED.
 */
export function classifyBootLogs(logs: string): ProofErrorType {
  const text = (logs ?? "").toLowerCase();
  const reachedStart = /(npm run start|> start\b|listening on|server (?:running|started|listening)|ready on|started server)/.test(text);
  if (reachedStart) return "RUNTIME_ERROR";
  const reachedBuild = /(npm run build|> build\b|\btsc\b|vite build|next build|error ts\d+)/.test(text);
  if (reachedBuild) return "BUILD_FAILED";
  return "INSTALL_FAILED";
}

// ── Server startup (docker sandbox + local fallback) ────────────────────────

export interface StartSandboxServerOptions {
  /** Injected dockerode client (or mock). Defaults to a real, lazy-loaded client. */
  docker?: Docker;
  /** Injected Docker-availability probe. Lets tests skip the real CLI. */
  checkDocker?: () => void;
  /** Injected port waiter (defaults to a real TCP probe). */
  waitForPort?: (port: number, timeoutMs: number) => Promise<void>;
  /** Injected container-log reader (defaults to `container.logs`). */
  readLogs?: (container: Docker.Container) => Promise<string>;
  /** How long to wait for the port before classifying a boot failure. */
  readyTimeoutMs?: number;
}

/**
 * Start the project inside an isolated Docker sandbox ({@link startSandbox}), wait
 * until its published port is reachable, and return a {@link ServerHandle} whose
 * `stop()` tears the container down. On a boot timeout it reads the container logs,
 * classifies the failing phase, removes the container, and throws a
 * {@link BootFailure} — so no half-booted container survives.
 */
export async function startSandboxServer(
  dirPath: string,
  port: number,
  options: StartSandboxServerOptions = {},
): Promise<ServerHandle> {
  const container = await startSandbox(dirPath, port, {
    docker: options.docker,
    checkDocker: options.checkDocker,
  });
  let stopped = false;
  const handle: ServerHandle = {
    port,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await stopSandbox(container);
    },
  };

  const wait = options.waitForPort ?? waitForPort;
  try {
    await wait(port, options.readyTimeoutMs ?? DEFAULT_SANDBOX_READY_TIMEOUT_MS);
  } catch (err) {
    // Read the logs BEFORE removing the container (removal loses them).
    const logs = await (options.readLogs ?? readContainerLogs)(container);
    const type = classifyBootLogs(logs);
    await handle.stop();
    throw new BootFailure(
      type,
      `The project never became ready on port ${port} (${errMessage(err)}).`,
      logs.trim().length > 0 ? logs : undefined,
    );
  }
  return handle;
}

/**
 * Local fallback server (no Docker): `npm install` on the host, spawn the project,
 * and wait for its port. Install failures surface as INSTALL_FAILED; a server that
 * never comes up as RUNTIME_ERROR. The returned handle's `stop()` kills the whole
 * process tree.
 */
export async function startLocalServer(dirPath: string, port: number): Promise<ServerHandle> {
  try {
    await defaultInstallDeps(dirPath);
  } catch (err) {
    throw new BootFailure("INSTALL_FAILED", `\`npm install\` failed: ${errMessage(err)}`, errDetails(err));
  }

  const handle = await spawnServerProcess(dirPath, port);
  try {
    await waitForPort(port, DEFAULT_SANDBOX_READY_TIMEOUT_MS);
  } catch (err) {
    await handle.stop();
    throw new BootFailure(
      "RUNTIME_ERROR",
      `The local server never became ready on port ${port} (${errMessage(err)}).`,
      errDetails(err),
    );
  }
  return handle;
}

/** Read a container's combined stdout+stderr (best-effort; empty string on error). */
export async function readContainerLogs(container: Docker.Container): Promise<string> {
  try {
    const out = await container.logs({ stdout: true, stderr: true, follow: false, tail: 400 });
    return Buffer.isBuffer(out) ? out.toString("utf8") : String(out);
  } catch {
    return "";
  }
}

/** Resolve once a TCP connection to `port` succeeds, or reject after `timeoutMs`. */
export function waitForPort(port: number, timeoutMs: number, host = "127.0.0.1"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((resolvePort, rejectPort) => {
    const attempt = (): void => {
      const socket = createConnection({ port, host });
      socket.once("connect", () => {
        socket.destroy();
        resolvePort();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          rejectPort(new Error(`Server on port ${port} was not reachable within ${timeoutMs} ms.`));
        } else {
          setTimeout(attempt, 300);
        }
      });
    };
    attempt();
  });
}

/** Run `npm install` in `dirPath` via spawn (no shell), failing loudly on a non-zero exit. */
export async function defaultInstallDeps(
  dirPath: string,
  timeoutMs: number = DEFAULT_INSTALL_TIMEOUT_MS,
): Promise<void> {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await runToCompletion(npm, ["install"], dirPath, timeoutMs);
}

export interface SpawnServerOptions {
  /** Command to run (defaults to the platform `npm`). */
  command?: string;
  /** Arguments (defaults to `["run", "start"]`). */
  args?: string[];
  /** Extra environment variables merged over the current env (plus `PORT`). */
  env?: NodeJS.ProcessEnv;
  /** SIGTERM→SIGKILL grace period on stop (default {@link DEFAULT_KILL_GRACE_MS}). */
  killGraceMs?: number;
}

/**
 * Spawn the project's local server as a child process and return a handle whose
 * `stop()` tears down the whole process tree cleanly. Uses `spawn` (never `exec`)
 * so we own the PID; on POSIX the child leads its own process group so the group
 * can be signalled, and on Windows the tree is force-closed with `taskkill`.
 */
export async function spawnServerProcess(
  dirPath: string,
  port: number,
  options: SpawnServerOptions = {},
): Promise<ServerHandle> {
  const command = options.command ?? (process.platform === "win32" ? "npm.cmd" : "npm");
  const args = options.args ?? ["run", "start"];
  const child = spawnCommand(command, args, {
    cwd: dirPath,
    env: { ...process.env, PORT: String(port), ...options.env },
    stdio: "ignore",
    // Own process group on POSIX so stop() can kill the whole tree via -pid.
    detached: process.platform !== "win32",
  });

  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("spawn", () => resolveSpawn());
    child.once("error", (err) => rejectSpawn(err));
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await terminateChild(child, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
  };

  return { port, pid: child.pid, stop };
}

// ── Playwright capture ──────────────────────────────────────────────────────

export interface BrowserCheckOptions {
  /** Viewport / recorded video size. */
  viewport?: { width: number; height: number };
  /** Explicit demo steps; defaults to an adaptive smartDemo (auth form or scroll). */
  actions?: DemoAction[];
  /** Fallback form data for `autofillForm` steps. */
  formData?: DemoFormData;
  /** Hold time after the interaction before finishing the recording (ms). */
  durationMs?: number;
  /** Navigation timeout so a dead server fails fast instead of hanging (ms). */
  navTimeoutMs?: number;
}

/**
 * Drive `url` with Playwright: capture console errors, uncaught page errors, and
 * HTTP 5xx responses, run an adaptive demo, and — only if nothing went wrong —
 * transcode the recording into an MP4 proof video. The browser is always torn
 * down (try/finally); a navigation failure (e.g. the server never came up) is
 * returned as an error rather than thrown, so the prover can react to it.
 */
export async function runBrowserChecks(
  url: string,
  options: BrowserCheckOptions = {},
): Promise<BrowserCheckResult> {
  const viewport = options.viewport ?? { width: 1280, height: 720 };
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const outDir = await mkdtemp(join(tmpdir(), "proofcast-prove-"));
  const errors: string[] = [];

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
    context = await browser.newContext({ viewport, recordVideo: { dir: outDir, size: viewport } });
    const page = await context.newPage();
    const video = page.video();

    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
    page.on("response", (res) => {
      if (res.status() >= 500) errors.push(`http ${res.status()} ${res.url()}`);
    });

    const response = await page.goto(url, {
      waitUntil: "load",
      timeout: options.navTimeoutMs ?? 15_000,
    });
    if (response && response.status() >= 500) {
      errors.push(`http ${response.status()} ${url}`);
    }

    if (options.actions && options.actions.length > 0) {
      await runDemoActions(page, options.actions, { formData: options.formData });
    } else {
      await smartDemo(page, options.formData);
    }
    await page.waitForTimeout(options.durationMs ?? 800);

    // Finalize the recording before we transcode.
    await context.close();
    context = undefined;
    await browser.close();
    browser = undefined;

    if (errors.length > 0) {
      return { errors };
    }
    if (!video) {
      return { errors: [] }; // healthy, but no video track was available
    }
    const webmPath = await video.path();
    const { mp4Path } = await transcodeToMp4(webmPath);
    const buffer = await readFile(mp4Path);
    return { errors: [], video: buffer };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return { errors };
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        /* already closing */
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* already closing */
      }
    }
  }
}

// ── Process teardown helpers ────────────────────────────────────────────────

/**
 * SIGTERM a child (its whole group on POSIX), then SIGKILL after `graceMs` if it
 * has not exited. Resolves once the process is actually gone. Idempotent and
 * never throws for an already-dead process.
 */
async function terminateChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return; // already exited or never really started
  }
  const pid = child.pid;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));

  signalTree(child, pid, "SIGTERM");

  const killTimer = setTimeout(() => signalTree(child, pid, "SIGKILL"), graceMs);
  if (typeof killTimer.unref === "function") killTimer.unref();

  // Hard cap so stop() can NEVER block forever, even if `exit` never arrives:
  // SIGKILL is uncatchable, so this is a belt-and-suspenders backstop only.
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolveCap) => {
    capTimer = setTimeout(resolveCap, graceMs + 2_000);
  });
  if (capTimer && typeof capTimer.unref === "function") capTimer.unref();

  try {
    await Promise.race([exited, cap]);
  } finally {
    clearTimeout(killTimer);
    if (capTimer) clearTimeout(capTimer);
  }
}

/** Best-effort signal to a child and its descendants, per platform. */
function signalTree(child: ChildProcess, pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    if (process.platform === "win32") {
      if (signal === "SIGKILL") {
        // No POSIX groups on Windows: force-kill the whole tree.
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill(); // graceful terminate of the spawned process
      }
    } else {
      // Negative pid → the child's process group (it is the group leader).
      process.kill(-pid, signal);
    }
  } catch {
    /* the process (or group) is already gone */
  }
}

/** Spawn a command and resolve on exit 0, rejecting on error / non-zero / timeout. */
function runToCompletion(command: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnCommand(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += String(chunk);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.once("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectPromise(new Error(`\`${command} ${args.join(" ")}\` timed out after ${timeoutMs} ms.`));
      } else if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(
          new Error(`\`${command} ${args.join(" ")}\` failed (exit ${code ?? signal}): ${stderr.trim().slice(-500)}`),
        );
      }
    });
  });
}

/**
 * On Windows, npm is a `.cmd` shim and Node (>=18.20 / 20.x) refuses to spawn a
 * `.cmd`/`.bat` file without a shell (it throws `EINVAL`). Those must go through
 * cmd.exe; plain executables (a real `node.exe`, a POSIX `npm`) are spawned
 * directly so a path containing spaces is not re-parsed by the shell. The command
 * and args at every call site are static literals — never model input — so
 * enabling the shell here adds no command-injection surface.
 */
function needsWindowsShell(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

/**
 * `spawn`, but transparently routing a Windows `.cmd`/`.bat` shim through the
 * shell (see {@link needsWindowsShell}). When the shell is used we fold the args
 * into the command line and pass none, so Node does not emit the DEP0190 warning
 * about un-escaped args under `shell` — safe precisely because these args are
 * always static literals, never model-supplied.
 */
function spawnCommand(command: string, args: string[], options: SpawnOptions): ChildProcess {
  // Guard the cwd: spawning with a non-existent working directory throws a
  // confusing `ENOENT` against the executable (on Windows, against the shell) —
  // turn it into a clear, actionable error before we ever spawn.
  if (typeof options.cwd === "string" && !existsSync(options.cwd)) {
    throw new Error(`Le dossier de travail n'existe pas : ${options.cwd}`);
  }
  if (needsWindowsShell(command)) {
    return spawn([command, ...args].join(" "), [], { ...options, shell: true });
  }
  return spawn(command, args, options);
}

/** True when `dirPath` exists and is a directory (never throws). */
async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

/** Message of an unknown error value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Stack/details of an unknown error value, if any. */
function errDetails(err: unknown): string | undefined {
  return err instanceof Error ? (err.stack ?? undefined) : undefined;
}
