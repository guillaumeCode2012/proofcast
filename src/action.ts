/**
 * ProofCast GitHub Action glue — put the proof *inside* the pull request.
 *
 * The action itself (see `action.yml`) does the plumbing: install ProofCast, run
 * `proofcast run --local --share`, upload the MP4 as a workflow artifact. This
 * module turns the resulting one-line JSON {@link CliOutput} into the three
 * things a reviewer actually sees:
 *
 *   1. a PR comment carrying the report (feature, status, duration) + the link to
 *      the video artifact — UPSERTED via a hidden marker, so re-running on a new
 *      push edits the existing comment instead of spamming the thread;
 *   2. a commit status (`proofcast/proof`) on the PR's HEAD sha, pass/fail from
 *      `report.success` — the check reviewers gate merges on;
 *   3. a job summary, so the proof is readable straight from the run page.
 *
 * Everything reaches GitHub through `gh api` (preinstalled on every runner) via
 * the same injectable {@link CommandRunner} the rest of the repo uses — no shell,
 * no octokit dependency, and fully testable without a network. The formatting
 * helpers below are pure so the comment body is asserted in `test/action.test.mjs`.
 *
 * Design rule: reporting NEVER changes the verdict. A GitHub hiccup (no token, no
 * PR context, API 5xx) is logged and swallowed — the proof result is carried by
 * the step's own exit code, which `action.yml` derives from the report itself.
 */

import { readFile } from "node:fs/promises";

import { runCommand, type CommandResult, type CommandRunner } from "./github.js";
import { isProcessEntryPoint } from "./path-resolver.js";
import type { ProofError } from "./prover.js";

/**
 * Hidden HTML marker stamped into every comment ProofCast writes. It is how a
 * later run finds the comment it already owns — the upsert key. Changing this
 * string orphans existing comments, so treat it as a stable contract.
 */
export const PROOF_COMMENT_MARKER = "<!-- proofcast:proof-report -->";

/** Commit-status context — the check name reviewers see and can require for merge. */
export const PROOF_STATUS_CONTEXT = "proofcast/proof";

/** Per-`gh` wall-clock cap. The API calls are small; a hang must not stall the job. */
export const DEFAULT_GH_TIMEOUT_MS = 60_000;

/** How much of a failure's `details` (stack, console dump) is quoted in the comment. */
export const MAX_DETAILS_CHARS = 1_500;

/**
 * The subset of the CLI's stdout contract this module consumes. Kept structural
 * rather than importing `CliOutput` so a report parsed from JSON at runtime is
 * typed by what it actually guarantees.
 */
export interface ProofOutput {
  success: boolean;
  proofPath?: string;
  sharePath?: string;
  errors?: ProofError[];
  error?: string;
  durationMs: number;
}

/**
 * Pull the report out of captured `proofcast run` stdout.
 *
 * The CLI contract is "exactly one line of JSON on stdout", but a runner can
 * interleave npm/playwright noise into the same capture, so we scan lines and keep
 * the LAST parseable JSON object that looks like a report. Returns `null` when
 * nothing qualifies — the caller then reports a transparent "no report" failure
 * rather than inventing a passing proof.
 */
export function parseProofOutput(stdout: string): ProofOutput | null {
  let found: ProofOutput | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      // `success` is the one field every CliOutput carries; it is what makes a
      // line a report rather than some other tool's JSON log line.
      if (parsed && typeof parsed === "object" && typeof (parsed as ProofOutput).success === "boolean") {
        found = parsed as ProofOutput;
      }
    } catch {
      /* not JSON — just runner noise */
    }
  }
  return found;
}

/** Render a duration the way a human reads it: `840 ms`, `4.9 s`, `1 min 12 s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes} min ${seconds} s`;
}

/** Everything the comment/summary needs beyond the report itself. */
export interface ProofCommentInput {
  report: ProofOutput;
  /** Human label for what was proven (defaults to the proven directory's name). */
  feature: string;
  /** `actions/upload-artifact` download URL for the video, when the upload succeeded. */
  artifactUrl?: string;
  /** Artifact name, so the comment can name the file to download. */
  artifactName?: string;
  /** Link back to the workflow run that produced this. */
  runUrl?: string;
  /** ProofCast version that produced the proof, for the footer. */
  version?: string;
}

/**
 * Build the PR comment body: the marker, a verdict headline, a small report table
 * and — the point of the whole thing — a link to the playable video. On failure it
 * lists the typed prover errors with their details folded into a `<details>` block.
 */
export function formatProofComment(input: ProofCommentInput): string {
  const { report, feature, artifactUrl, artifactName, runUrl, version } = input;
  const passed = report.success === true;

  const lines: string[] = [PROOF_COMMENT_MARKER, ""];
  lines.push(passed ? "### ✅ ProofCast — proof passed" : "### ❌ ProofCast — proof failed");
  lines.push("");
  lines.push("| | |");
  lines.push("| :-- | :-- |");
  lines.push(`| **Feature** | ${escapeCell(feature)} |`);
  lines.push(`| **Status** | ${passed ? "✅ PASSED" : "❌ FAILED"} |`);
  lines.push(`| **Duration** | ${formatDuration(report.durationMs)} |`);
  if (passed) {
    const label = artifactName ?? "proofcast-proof";
    lines.push(
      `| **Proof video** | ${artifactUrl ? `[⬇️ ${escapeCell(label)}](${artifactUrl})` : `\`${escapeCell(label)}\` artifact on the run`} |`,
    );
  }
  lines.push("");

  if (passed) {
    lines.push(
      "🎬 **This feature was driven in a real browser and recorded.** Evidence you can play, " +
        "not a checkmark you trust.",
    );
    lines.push("");
    // Say what is in the zip. GitHub cannot preview an artifact inline, so without
    // this the reader downloads a file and guesses what to open.
    lines.push(
      "> Download the artifact and open **`proofcast-proof.mp4`** — or open " +
        "**`proof-…/index.html`**, a self-contained page that plays the video next to the " +
        "report, with no server and no CDN.",
    );
  } else {
    lines.push("This pull request has **no valid proof**. The prover reported:");
    lines.push("");
    for (const err of report.errors ?? []) {
      lines.push(`- **\`${err.type}\`** — ${escapeCell(err.message)}`);
      if (err.details?.trim()) {
        lines.push("");
        lines.push("  <details><summary>details</summary>");
        lines.push("");
        lines.push("  ```");
        for (const l of truncate(err.details.trim(), MAX_DETAILS_CHARS).split(/\r?\n/)) {
          lines.push(`  ${l}`);
        }
        lines.push("  ```");
        lines.push("");
        lines.push("  </details>");
      }
      lines.push("");
    }
    // `error` carries usage/config-level failures, which never populate `errors`.
    if (!report.errors?.length && report.error) {
      lines.push(`- ${escapeCell(report.error)}`);
      lines.push("");
    }
    if (!report.errors?.length && !report.error) {
      lines.push("- The prover produced no report. Check the workflow logs for the raw output.");
      lines.push("");
    }
  }

  lines.push("");
  const footer = [
    `Proven by [ProofCast](https://github.com/guillaumeCode2012/proofcast)${version ? ` v${version}` : ""}`,
    runUrl ? `[workflow run](${runUrl})` : null,
  ].filter(Boolean);
  lines.push(`<sub>${footer.join(" · ")}</sub>`);
  return lines.join("\n");
}

/** One-line status description (GitHub truncates commit statuses at 140 chars). */
export function statusDescription(report: ProofOutput): string {
  const base = report.success
    ? `Proof passed in ${formatDuration(report.durationMs)}`
    : `Proof failed: ${report.errors?.[0]?.message ?? report.error ?? "no report produced"}`;
  return truncate(base, 140);
}

// ── GitHub side-effects ──────────────────────────────────────────────────────

/** The PR/commit coordinates the reporter needs, resolved from the runner env. */
export interface ActionContext {
  /** `owner/repo`. */
  repository: string;
  /** PR number, or `undefined` when this run is not attached to a pull request. */
  prNumber?: number;
  /**
   * The sha the status lands on. On a `pull_request` event `GITHUB_SHA` is the
   * ephemeral MERGE commit, which shows no check on the PR — so the head sha from
   * the event payload wins when present.
   */
  sha?: string;
  runUrl?: string;
  /**
   * True when the PR comes from a fork. GitHub hands `pull_request` runs from a
   * fork a READ-ONLY token, so commenting and setting the status are refused with
   * 403 no matter what the workflow's `permissions:` block says. Knowing this lets
   * the reporter explain the real cause instead of blaming the user's config.
   */
  isFork?: boolean;
}

/** The GitHub event payload fields this module reads (everything else is ignored). */
interface EventPayload {
  pull_request?: {
    number?: number;
    head?: { sha?: string; repo?: { full_name?: string; fork?: boolean } };
    base?: { repo?: { full_name?: string } };
  };
}

/**
 * Resolve {@link ActionContext} from the runner environment + the event payload
 * file. Never throws: a missing/broken payload just yields no PR number, which
 * downgrades the run to "status + summary only".
 */
export async function resolveContext(
  env: NodeJS.ProcessEnv,
  readEventFile: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<ActionContext> {
  const repository = env.GITHUB_REPOSITORY ?? "";
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  const runUrl = env.GITHUB_RUN_ID ? `${server}/${repository}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;

  let payload: EventPayload = {};
  if (env.GITHUB_EVENT_PATH) {
    try {
      payload = JSON.parse(await readEventFile(env.GITHUB_EVENT_PATH)) as EventPayload;
    } catch {
      /* not a PR event, or unreadable — fall through to the env-only context */
    }
  }

  const pr = payload.pull_request;
  const prNumber = pr?.number;
  // `fork` is authoritative when present; comparing repo names also catches a PR
  // opened from a fork whose flag the payload happens to omit.
  const headRepo = pr?.head?.repo;
  const isFork =
    headRepo === undefined
      ? undefined
      : headRepo.fork === true ||
        (Boolean(headRepo.full_name) &&
          Boolean(pr?.base?.repo?.full_name) &&
          headRepo.full_name !== pr?.base?.repo?.full_name);

  return {
    repository,
    prNumber: typeof prNumber === "number" ? prNumber : undefined,
    sha: pr?.head?.sha ?? env.GITHUB_SHA,
    runUrl,
    isFork,
  };
}

/** Injectable side-effects for {@link reportProof}. Defaults are the real ones. */
export interface ReportDependencies {
  exec: CommandRunner;
  env: NodeJS.ProcessEnv;
  /** Append a line to a runner file (`$GITHUB_STEP_SUMMARY`, `$GITHUB_OUTPUT`). */
  appendFile: (path: string, content: string) => Promise<void>;
  log: (line: string) => void;
  timeoutMs: number;
}

/** What the reporter actually managed to do — asserted by the tests, logged in CI. */
export interface ReportResult {
  /** `created` / `updated` when a PR comment was written, `skipped` otherwise. */
  comment: "created" | "updated" | "skipped";
  /** `set` when the commit status was posted, `skipped` otherwise. */
  status: "set" | "skipped";
  /** The verdict carried through — what `action.yml` turns into the exit code. */
  success: boolean;
}

/**
 * Post the proof to the pull request: upsert the comment, set the commit status,
 * write the job summary. Returns what it did; it does not throw and does not
 * decide the build's fate.
 */
export async function reportProof(
  input: ProofCommentInput & { context: ActionContext; comment: boolean; status: boolean },
  overrides: Partial<ReportDependencies> = {},
): Promise<ReportResult> {
  const deps: ReportDependencies = {
    exec: overrides.exec ?? runCommand,
    env: overrides.env ?? process.env,
    appendFile: overrides.appendFile ?? (async (p, c) => void (await appendTo(p, c))),
    log: overrides.log ?? ((line) => void process.stdout.write(`${line}\n`)),
    timeoutMs: overrides.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS,
  };
  const { context, report } = input;
  const body = formatProofComment(input);

  // The summary is local to the runner — write it first so the proof is visible on
  // the run page even if every API call below fails.
  if (deps.env.GITHUB_STEP_SUMMARY) {
    await deps.appendFile(deps.env.GITHUB_STEP_SUMMARY, `${body}\n`).catch((err) => {
      deps.log(`ProofCast: could not write the job summary (${messageOf(err)}).`);
    });
  }

  let comment: ReportResult["comment"] = "skipped";
  if (input.comment && context.prNumber && context.repository) {
    comment = await upsertComment(deps, context, context.prNumber, body);
  } else if (input.comment) {
    deps.log("ProofCast: no pull-request context — skipping the PR comment.");
  }

  let status: ReportResult["status"] = "skipped";
  if (input.status && context.sha && context.repository) {
    status = await setCommitStatus(deps, context, report);
  } else if (input.status) {
    deps.log("ProofCast: no commit sha — skipping the status check.");
  }

  return { comment, status, success: report.success === true };
}

/**
 * Create the proof comment, or edit the one this action already owns. Identity
 * comes from {@link PROOF_COMMENT_MARKER}, so a PR accumulates one living comment
 * across pushes instead of a wall of stale reports.
 */
async function upsertComment(
  deps: ReportDependencies,
  context: ActionContext,
  prNumber: number,
  body: string,
): Promise<"created" | "updated" | "skipped"> {
  const repository = context.repository;
  const existingId = await findExistingComment(deps, repository, prNumber);

  const call = existingId
    ? gh(deps, ["api", "--method", "PATCH", `repos/${repository}/issues/comments/${existingId}`, "-f", `body=${body}`])
    : gh(deps, ["api", "--method", "POST", `repos/${repository}/issues/${prNumber}/comments`, "-f", `body=${body}`]);

  const res = await call;
  if (res.exitCode !== 0) {
    warnPublishFailure(deps, context, `${existingId ? "update" : "post"} the PR comment`, "pull-requests: write", res);
    return "skipped";
  }
  deps.log(`ProofCast: proof comment ${existingId ? "updated" : "posted"} on PR #${prNumber}.`);
  return existingId ? "updated" : "created";
}

/**
 * Explain a failed publish as a GitHub ANNOTATION, diagnosed correctly.
 *
 * Two very different causes produce the same 403, and telling them apart is the
 * whole value here. On a PR from a fork the token is read-only by design, and no
 * `permissions:` block can change that — sending the user to edit their workflow
 * would be a wild goose chase. Everywhere else, a missing scope really is the
 * cause. `::warning::` (not a log line) so it surfaces on the run and in the PR's
 * checks UI, where someone wondering "why is there no comment?" will actually look.
 */
function warnPublishFailure(
  deps: ReportDependencies,
  context: ActionContext,
  action: string,
  scope: string,
  res: CommandResult,
): void {
  const detail = (res.stderr || res.stdout).trim().slice(0, 300);
  if (context.isFork) {
    deps.log(
      `::warning::ProofCast proved this pull request, but could not ${action}: it comes from a FORK, ` +
        "and GitHub gives `pull_request` runs from forks a read-only token. This is not a misconfiguration — " +
        "no `permissions:` block can grant it. The proof itself ran and is in this job's summary and artifact.",
    );
    return;
  }
  deps.log(
    `::warning::ProofCast could not ${action} (${detail}). ` +
      `Add \`${scope}\` to the job's \`permissions:\` block.`,
  );
}

/** Find this action's own comment id on the PR, or `null`. Never throws. */
async function findExistingComment(
  deps: ReportDependencies,
  repository: string,
  prNumber: number,
): Promise<string | null> {
  const res = await gh(deps, [
    "api",
    "--paginate",
    `repos/${repository}/issues/${prNumber}/comments`,
    "--jq",
    `[.[] | select(.body | contains("${PROOF_COMMENT_MARKER}")) | .id] | first // empty`,
  ]);
  if (res.exitCode !== 0) return null;
  const id = res.stdout.trim().split(/\r?\n/)[0]?.trim();
  return id && /^\d+$/.test(id) ? id : null;
}

/** Post the pass/fail commit status that becomes the PR's `proofcast/proof` check. */
async function setCommitStatus(
  deps: ReportDependencies,
  context: ActionContext,
  report: ProofOutput,
): Promise<"set" | "skipped"> {
  const args = [
    "api",
    "--method",
    "POST",
    `repos/${context.repository}/statuses/${context.sha}`,
    "-f",
    `state=${report.success ? "success" : "failure"}`,
    "-f",
    `context=${PROOF_STATUS_CONTEXT}`,
    "-f",
    `description=${statusDescription(report)}`,
  ];
  if (context.runUrl) args.push("-f", `target_url=${context.runUrl}`);

  const res = await gh(deps, args);
  if (res.exitCode !== 0) {
    warnPublishFailure(deps, context, "publish the proof check", "statuses: write", res);
    return "skipped";
  }
  deps.log(`ProofCast: commit status \`${PROOF_STATUS_CONTEXT}\` = ${report.success ? "success" : "failure"}.`);
  return "set";
}

/** Run `gh` with the action's token, never throwing — a transport error becomes exit 1. */
function gh(deps: ReportDependencies, args: string[]): Promise<CommandResult> {
  return deps.exec("gh", args, { timeoutMs: deps.timeoutMs }).catch((err: unknown) => ({
    stdout: "",
    stderr: messageOf(err),
    exitCode: 1,
  }));
}

// ── binary entry point (invoked by action.yml) ───────────────────────────────

/**
 * The `dist/action.js` entry `action.yml` runs after the proof + artifact upload.
 *
 * Its whole input surface is environment variables, because that is what a
 * composite action can hand a script cleanly. It reports the proof, publishes the
 * step outputs, and returns the exit code: non-zero when the proof failed (unless
 * `PROOFCAST_FAIL_ON_ERROR=false`), which is what turns a missing proof into a
 * red pull request.
 */
export async function actionMain(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<ReportDependencies> = {},
): Promise<number> {
  const log = overrides.log ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const appendFile = overrides.appendFile ?? (async (p: string, c: string) => void (await appendTo(p, c)));

  const reportFile = env.PROOFCAST_REPORT_FILE;
  let raw = "";
  if (reportFile) {
    raw = await readFile(reportFile, "utf8").catch(() => "");
  }
  const parsed = parseProofOutput(raw);
  // No parseable report is itself a failure — never let an unreadable run look green.
  const report: ProofOutput = parsed ?? {
    success: false,
    durationMs: 0,
    error: "ProofCast produced no parseable JSON report. See the workflow logs for the raw output.",
  };

  const context = await resolveContext(env);
  const result = await reportProof(
    {
      report,
      feature: env.PROOFCAST_FEATURE?.trim() || "the project",
      artifactUrl: env.PROOFCAST_ARTIFACT_URL?.trim() || undefined,
      artifactName: env.PROOFCAST_ARTIFACT_NAME?.trim() || undefined,
      runUrl: context.runUrl,
      version: env.PROOFCAST_VERSION?.trim() || undefined,
      context,
      comment: env.PROOFCAST_COMMENT !== "false",
      status: env.PROOFCAST_STATUS !== "false",
    },
    { ...overrides, env, log, appendFile },
  );

  if (env.GITHUB_OUTPUT) {
    await appendFile(
      env.GITHUB_OUTPUT,
      [
        `success=${result.success}`,
        `duration-ms=${report.durationMs}`,
        `proof-path=${report.proofPath ?? ""}`,
        `comment=${result.comment}`,
        "",
      ].join("\n"),
    ).catch((err) => log(`ProofCast: could not write step outputs (${messageOf(err)}).`));
  }

  if (!result.success && env.PROOFCAST_FAIL_ON_ERROR !== "false") {
    log("ProofCast: no valid proof for this pull request — failing the job.");
    return 1;
  }
  return 0;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Keep a table cell on one row: no pipes, no newlines. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/** Clip `value` to `max` characters, marking the cut so nothing looks complete when it isn't. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… (truncated)`;
}

/** Append to a file, creating it when absent. */
async function appendTo(path: string, content: string): Promise<void> {
  const { appendFile: append } = await import("node:fs/promises");
  await append(path, content, "utf8");
}

/** Message of an unknown error value. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Run only when invoked directly as a binary (never on a library import / test).
if (isProcessEntryPoint(import.meta.url)) {
  void actionMain().then((code) => {
    process.exitCode = code;
  });
}
