/**
 * ProofCast readiness — zero-friction onboarding.
 *
 * The AI agent driving ProofCast runs `npm run setup`, which builds, installs
 * Chromium, then calls {@link checkReadiness} to report exactly what is done and
 * what still needs a human gesture (create the Telegram bot, `vercel login`).
 *
 * There is NO interactive CLI: this only reports state + next actions; the agent
 * relays the irreducible human steps.
 */

import { isVercelInstalled } from "./deployer.js";
import { loadToken } from "./onboarding.js";

export interface ReadinessCheck {
  key: "ai" | "telegram" | "vercel";
  ok: boolean;
  detail: string;
}

export interface Readiness {
  checks: ReadinessCheck[];
  /** True when the bot can be started (AI provider + Telegram token present). */
  ready: boolean;
  /** Human-readable, agent-actionable next steps. */
  nextActions: string[];
}

export interface CheckReadinessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Override the Vercel probe (tests). Defaults to a real `vercel --version`. */
  vercelInstalled?: boolean;
}

/** Inspect the environment and report what ProofCast still needs to go live. */
export function checkReadiness(options: CheckReadinessOptions = {}): Readiness {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const hasAnthropic = Boolean(env.ANTHROPIC_API_KEY?.trim() && env.ANTHROPIC_MODEL?.trim());
  const hasOpenai = Boolean(env.OPENAI_API_KEY?.trim() && env.OPENAI_MODEL?.trim());
  const aiOk = hasAnthropic || hasOpenai;

  let telegramOk = false;
  try {
    telegramOk = loadToken(cwd) !== null;
  } catch {
    telegramOk = false; // corrupt config → treat as not configured
  }

  const vercelOk = options.vercelInstalled ?? isVercelInstalled();

  const checks: ReadinessCheck[] = [
    {
      key: "ai",
      ok: aiOk,
      detail: aiOk
        ? `provider configured (${hasAnthropic ? "anthropic" : "openai"})`
        : "no provider key + model in the environment",
    },
    {
      key: "telegram",
      ok: telegramOk,
      detail: telegramOk ? "bot token saved" : "no bot token saved yet",
    },
    {
      key: "vercel",
      ok: vercelOk,
      detail: vercelOk ? "CLI available" : "CLI not found (needed only for « Déploie »)",
    },
  ];

  const nextActions: string[] = [];
  if (!aiOk) {
    nextActions.push(
      "Configure an AI provider in the environment: ANTHROPIC_API_KEY + ANTHROPIC_MODEL, " +
        "or OPENAI_API_KEY + OPENAI_MODEL. Do not ask the user for the key value if it is already set.",
    );
  }
  if (!telegramOk) {
    nextActions.push(
      "Ask the user ONLY for the bot name, share generateBotFatherLink(name), then call " +
        "saveToken(<the token the user pastes back>). Never ask for the token in the terminal.",
    );
  }
  if (!vercelOk) {
    nextActions.push(
      "For deploys only: install the Vercel CLI (npm i -g vercel) and have the user run " +
        "`vercel login` in the browser — then WAIT for their explicit confirmation. Do not poll.",
    );
  }
  if (aiOk && telegramOk) {
    nextActions.push("Ready — call startBot(). The user then uses « Démo » / « Déploie » from Telegram.");
  }

  return { checks, ready: aiOk && telegramOk, nextActions };
}

/** Render a {@link Readiness} as a compact human/agent-readable report. */
export function formatReadiness(readiness: Readiness): string {
  const lines = ["ProofCast readiness:"];
  for (const check of readiness.checks) {
    lines.push(`  ${check.ok ? "✓" : "✗"} ${check.key}: ${check.detail}`);
  }
  lines.push("", readiness.ready ? "STATUS: ready to start the bot." : "STATUS: not ready yet.");
  if (readiness.nextActions.length > 0) {
    lines.push("", "Next actions:");
    for (const action of readiness.nextActions) {
      lines.push(`  - ${action}`);
    }
  }
  return lines.join("\n");
}
