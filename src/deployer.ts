/**
 * ProofCast deployment via the Vercel CLI.
 *
 * Runs `vercel --yes --prod` through `execSync`, captures stdout to extract the
 * production URL, and surfaces build failures with their output.
 *
 * Security (NON NÉGOCIABLE):
 *   - Any caller-supplied argument is strictly validated BEFORE the command is
 *     built (see {@link assertSafeArg}). Shell metacharacters / whitespace are
 *     rejected outright — no command injection into `execSync`.
 *   - No secrets are placed on the command line. Auth relies on a prior
 *     `vercel login` (browser flow, driven by the user — see the README).
 */

import { execSync, type ExecSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";

/** Signature of the exec function — injectable so tests can mock `execSync`. */
export type ExecFn = (command: string, options?: ExecSyncOptions) => string | Buffer;

/** Thrown when the Vercel CLI is not available on PATH. */
export class VercelCliNotFoundError extends Error {
  constructor() {
    super(
      "Vercel CLI not found on PATH. Install it (e.g. `npm i -g vercel`) and run " +
        "`vercel login` (browser flow) before deploying.",
    );
    this.name = "VercelCliNotFoundError";
  }
}

/**
 * Thrown when Vercel is installed but the user is not logged in. Auth is a
 * browser OAuth flow that ONLY the human can complete — ProofCast never
 * automates it and never polls. We detect the state and tell the user exactly
 * what to do, once.
 */
export class VercelNotAuthenticatedError extends Error {
  constructor() {
    super(
      "Not logged in to Vercel. Run `vercel login` (browser flow — only you can " +
        "complete it), then re-run the deploy. ProofCast never logs in for you.",
    );
    this.name = "VercelNotAuthenticatedError";
  }
}

/** Thrown when a caller-supplied argument is unsafe for the shell. */
export class UnsafeArgumentError extends Error {
  constructor(arg: unknown) {
    super(`Refusing to pass an unsafe Vercel argument: ${JSON.stringify(arg)}`);
    this.name = "UnsafeArgumentError";
  }
}

/** Thrown when the deployment command exits non-zero (e.g. a build failure). */
export class DeploymentFailedError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  constructor(stdout: string, stderr: string) {
    const detail = (stderr || stdout || "").trim();
    super(`Vercel deployment failed${detail ? `:\n${firstLines(detail, 8)}` : "."}`);
    this.name = "DeploymentFailedError";
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** Thrown when the deploy succeeded but no URL could be extracted from stdout. */
export class DeploymentUrlNotFoundError extends Error {
  readonly output: string;
  constructor(output: string) {
    super("Deployment finished but no URL could be extracted from the Vercel output.");
    this.name = "DeploymentUrlNotFoundError";
    this.output = output;
  }
}

export interface DeployOptions {
  /** Injectable exec (defaults to `execSync`). Tests pass a mock. */
  exec?: ExecFn;
  /** Working directory to deploy from (passed via the exec options, not the command). */
  cwd?: string;
  /** Environment for the child process (defaults to the current environment). */
  env?: NodeJS.ProcessEnv;
  /** Extra Vercel args (e.g. `["--scope", "my-team"]`). Each is strictly validated. */
  extraArgs?: string[];
}

export interface DeployResult {
  /** The production deployment URL extracted from stdout. */
  url: string;
  /** The full captured stdout, for logging/inspection. */
  rawOutput: string;
}

/** Allowlist for CLI arguments: no whitespace, no shell metacharacters. */
const SAFE_ARG = /^[A-Za-z0-9._:@/=-]+$/;

/**
 * Signals in Vercel's output that mean "you are not authenticated" rather than
 * "your build broke". Used to turn an opaque non-zero exit into an actionable
 * {@link VercelNotAuthenticatedError} pointing the user at `vercel login`.
 */
const AUTH_HINT_RE =
  /no existing credentials|not (?:currently )?logged in|vercel login|please log ?in|not authenticated|credentials found/i;

/** True when Vercel output looks like an authentication problem (see {@link AUTH_HINT_RE}). */
export function looksLikeAuthError(text: string): boolean {
  return typeof text === "string" && AUTH_HINT_RE.test(text);
}

/** ANSI escape sequence (colors), stripped before URL extraction (ESC + "[...m"). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** URL matcher. */
const URL_RE = /https?:\/\/[^\s]+/g;

/** Trailing characters never part of a URL: control chars + closing punctuation. */
const URL_TRAILING = new RegExp("[\\u0000-\\u001f)\\].,;'\"]+$");

/**
 * Validate a single caller-supplied CLI argument, returning it unchanged.
 * @throws {UnsafeArgumentError} if it contains whitespace or shell metacharacters.
 */
export function assertSafeArg(arg: unknown): string {
  if (typeof arg !== "string" || arg.length === 0 || !SAFE_ARG.test(arg)) {
    throw new UnsafeArgumentError(arg);
  }
  return arg;
}

/** Return true if the Vercel CLI responds to `--version`. */
export function isVercelInstalled(exec: ExecFn = execSync): boolean {
  try {
    exec("vercel --version", { stdio: "pipe", encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return true if `vercel whoami` succeeds (i.e. the user has a valid session).
 * A single, non-interactive probe — never a login attempt and never a poll.
 */
export function isVercelAuthenticated(exec: ExecFn = execSync): boolean {
  try {
    exec("vercel whoami", { stdio: "pipe", encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the production URL from Vercel stdout. Strategy, in order:
 *   1. a line mentioning "Production" that contains a URL,
 *   2. otherwise the last `*.vercel.app` URL anywhere,
 *   3. otherwise the last URL of any kind.
 * Returns `null` when no URL is present.
 */
export function extractDeploymentUrl(output: string): string | null {
  if (typeof output !== "string") {
    return null;
  }
  const clean = output.replace(ANSI, "");
  const lines = clean.split(/\r?\n/);

  for (const line of lines) {
    if (/production/i.test(line)) {
      const first = line.match(URL_RE)?.[0];
      if (first) {
        return trimUrl(first);
      }
    }
  }

  const all = clean.match(URL_RE) ?? [];
  const vercelUrls = all.filter((u) => /vercel\.app/i.test(u));
  const preferred = vercelUrls.at(-1) ?? all.at(-1);
  return preferred ? trimUrl(preferred) : null;
}

/**
 * Deploy the current project to Vercel production and return the URL.
 *
 * @throws {UnsafeArgumentError}          if an extra arg is unsafe (checked first).
 * @throws {VercelCliNotFoundError}       if the CLI is not installed.
 * @throws {VercelNotAuthenticatedError}  if the failure looks like a missing login.
 * @throws {DeploymentFailedError}        if the deploy command exits non-zero.
 * @throws {DeploymentUrlNotFoundError}   if no URL is found in the output.
 */
export function deployWithVercel(options: DeployOptions = {}): DeployResult {
  const exec = options.exec ?? (execSync as ExecFn);

  // 1) Validate any caller-supplied args BEFORE building the command (fail fast).
  const extra = (options.extraArgs ?? []).map(assertSafeArg);

  // 2) Guard the working directory. A missing cwd otherwise surfaces as a
  //    confusing ENOENT (on Windows, against the shell) — the same class of bug
  //    that bit the sandbox spawn. Fail with a clear, actionable message instead.
  if (options.cwd !== undefined && !existsSync(options.cwd)) {
    throw new Error(`Le dossier à déployer n'existe pas : ${options.cwd}`);
  }

  // 3) Ensure the CLI exists.
  if (!isVercelInstalled(exec)) {
    throw new VercelCliNotFoundError();
  }

  // 4) Build a command from a fixed base plus only validated tokens.
  const command = ["vercel", "--yes", "--prod", ...extra].join(" ");

  let output: string;
  try {
    const result = exec(command, {
      encoding: "utf8",
      stdio: "pipe",
      cwd: options.cwd,
      env: options.env,
      // A production deploy can print a lot; keep well clear of execSync's 1 MB
      // default so a chatty build never trips ENOBUFS and masks the real result.
      maxBuffer: 32 * 1024 * 1024,
    });
    output = decode(result);
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown };
    const stdout = decode(e.stdout);
    const stderr = decode(e.stderr);
    // A non-zero exit that reads like "you are not logged in" is an auth problem,
    // not a build failure — surface the exact next step (`vercel login`).
    if (looksLikeAuthError(`${stdout}\n${stderr}`)) {
      throw new VercelNotAuthenticatedError();
    }
    throw new DeploymentFailedError(stdout, stderr);
  }

  const url = extractDeploymentUrl(output);
  if (!url) {
    throw new DeploymentUrlNotFoundError(output);
  }
  return { url, rawOutput: output };
}

/** Coerce an exec result / captured stream (string | Buffer | unknown) to a string. */
function decode(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

/** Trim trailing punctuation / control chars that are not part of a URL. */
function trimUrl(url: string): string {
  return url.replace(URL_TRAILING, "");
}

/** Keep at most the first `n` non-empty lines of `text` (for error messages). */
function firstLines(text: string, n: number): string {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, n).join("\n");
}
