/**
 * ProofCast onboarding.
 *
 * UX contract (driven by an AI agent, never an interactive terminal):
 *   - The ONLY thing we ask the user for is the bot NAME.
 *   - We NEVER prompt for a Telegram token in the terminal. Instead we hand the
 *     user a magic link to @BotFather; the user creates the bot there, then the
 *     agent relays the resulting token to `saveToken()`.
 *
 * Security contract:
 *   - `.proofcast-config.json` (which holds the token) is added to `.gitignore`
 *     automatically the moment it is created (creating `.gitignore` if needed).
 *   - The token format is validated before it is ever written to disk.
 *   - No secret is ever logged in clear text; use `maskToken()` for any output.
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** File that stores the Telegram token. Must always stay git-ignored. */
export const CONFIG_FILENAME = ".proofcast-config.json";

/** The git ignore file we keep the config entry in. */
export const GITIGNORE_FILENAME = ".gitignore";

/**
 * Telegram bot token: "<bot_id>:<35-char secret>".
 * e.g. 123456789:AAExampleExampleExampleExampleExampl
 */
export const TELEGRAM_TOKEN_REGEX = /^\d+:[A-Za-z0-9_-]{35}$/;

/** Telegram display names are 1..64 characters. */
const MAX_BOT_NAME_LENGTH = 64;

/** Shape persisted to `.proofcast-config.json`. */
export interface ProofcastConfig {
  telegramToken: string;
  createdAt: string;
}

/**
 * Build a magic link that opens a chat with @BotFather to create the bot.
 *
 * The `text` query param is a best-effort prefill of the `/newbot <name>`
 * command: most Telegram clients honor it; those that don't simply open the
 * BotFather chat where the user sends `/newbot` manually. No token is handled
 * here — this only bootstraps bot creation.
 */
export function generateBotFatherLink(botName: string): string {
  if (typeof botName !== "string") {
    throw new TypeError("botName must be a string.");
  }
  const trimmed = botName.trim();
  if (trimmed.length === 0) {
    throw new Error(
      "Bot name is required — it is the only thing ProofCast asks the user for.",
    );
  }
  if (trimmed.length > MAX_BOT_NAME_LENGTH) {
    throw new Error(
      `Bot name is too long: ${trimmed.length} chars (max ${MAX_BOT_NAME_LENGTH}).`,
    );
  }

  const command = `/newbot ${trimmed}`;
  return `https://t.me/BotFather?text=${encodeURIComponent(command)}`;
}

/**
 * Validate a Telegram token and persist it to `.proofcast-config.json`, then
 * make sure that file is git-ignored.
 *
 * @param token       Raw Telegram bot token.
 * @param projectRoot Directory to write into (defaults to the current project).
 *                    Explicitly injectable so tests never touch the real repo.
 * @throws If the token format is invalid. The invalid value is NOT echoed.
 */
export function saveToken(
  token: string,
  projectRoot: string = process.cwd(),
): void {
  const normalized = typeof token === "string" ? token.trim() : "";
  if (!TELEGRAM_TOKEN_REGEX.test(normalized)) {
    // Never echo the token itself — report only its length.
    throw new Error(
      `Invalid Telegram bot token format. Expected "<bot_id>:<35 chars>" ` +
        `matching ${TELEGRAM_TOKEN_REGEX.source}. ` +
        `Received a value of length ${normalized.length}.`,
    );
  }

  const root = resolve(projectRoot);
  const configPath = join(root, CONFIG_FILENAME);

  const config: ProofcastConfig = {
    telegramToken: normalized,
    createdAt: new Date().toISOString(),
  };

  // mode 0o600 = owner read/write only (no-op on Windows, useful on POSIX).
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  ensureConfigGitignored(root);
}

/**
 * Read a previously saved token. Returns `null` when no config exists yet.
 * @throws If the config file exists but is corrupt or holds an invalid token.
 */
export function loadToken(projectRoot: string = process.cwd()): string | null {
  const configPath = join(resolve(projectRoot), CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new Error(`${CONFIG_FILENAME} exists but is not valid JSON.`);
  }

  const token = (parsed as Partial<ProofcastConfig>).telegramToken;
  if (typeof token !== "string" || !TELEGRAM_TOKEN_REGEX.test(token)) {
    throw new Error(
      `${CONFIG_FILENAME} does not contain a valid Telegram token.`,
    );
  }
  return token;
}

/**
 * Mask a token for safe logging. The numeric bot id (before ":") is not a
 * credential and is kept for context; the 35-char secret is always hidden.
 */
export function maskToken(token: string): string {
  if (typeof token !== "string" || token.length === 0) {
    return "***";
  }
  const colon = token.indexOf(":");
  if (colon > 0) {
    return `${token.slice(0, colon)}:***`;
  }
  return "***";
}

/**
 * Ensure `.proofcast-config.json` is listed in `.gitignore`, creating the file
 * if it does not exist and appending the entry (without duplicating) if it does.
 */
function ensureConfigGitignored(projectRoot: string): void {
  const gitignorePath = join(projectRoot, GITIGNORE_FILENAME);

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${CONFIG_FILENAME}\n`, { encoding: "utf8" });
    return;
  }

  const contents = readFileSync(gitignorePath, "utf8");
  const alreadyIgnored = contents
    .split(/\r?\n/)
    .some((line) => line.trim() === CONFIG_FILENAME);
  if (alreadyIgnored) {
    return;
  }

  const needsLeadingNewline = contents.length > 0 && !contents.endsWith("\n");
  appendFileSync(
    gitignorePath,
    `${needsLeadingNewline ? "\n" : ""}${CONFIG_FILENAME}\n`,
    { encoding: "utf8" },
  );
}
