# AGENTS.md — ProofCast runbook (read this first)

You are an AI coding agent (Codex / Claude Code / Cursor / …) and this project is
**ProofCast**: an engine that records a **video proof** of a feature and deploys
**only after** the user has seen it. The user downloaded a zip, unzipped it, and
opened it in you. **Your job is to do everything for them.** Keep user friction
to the absolute minimum: the user should do only what is physically impossible
for you to do.

## Do this on “configure proofcast” (or when the user opens the project)

1. **Run one command:** `npm run setup`
   It installs dependencies, builds, installs Chromium, and prints a
   **readiness report** with the exact next actions. Follow that report.

2. **Read the readiness report.** It tells you what's configured and what's
   missing (AI provider, Telegram token, Vercel). Do the missing items below.

3. **AI provider** — if missing: it must be an environment variable
   (`ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL`, or `OPENAI_API_KEY` + `OPENAI_MODEL`).
   **Do NOT ask the user for the key value if it is already in the environment.**
   ProofCast never picks the model — the user's env decides.

4. **Telegram bot** — if missing:
   - Ask the user for **one thing only: the bot name.**
   - `generateBotFatherLink(name)` → give the user that link. They create the bot
     in Telegram and paste back the token.
   - `saveToken(theToken)` — persists it (auto-gitignored). **Never** ask for the
     token in the terminal; the user pastes it to you in chat.

5. **Vercel (for « Déploie » only)** — if the CLI is missing, install it
   (`npm i -g vercel`). Then run `vercel login` to open the browser flow, tell the
   user to finish it, and **WAIT** for them to say **“j'ai terminé la connexion.”**
   **You cannot complete this OAuth flow yourself. Never poll in a loop.**

6. **Start the bot:** `startBot()`. Then tell the user they can now send **`Démo`**
   and **`Déploie`** to their bot in Telegram.

## Hard rules (capabilities you do NOT have)

- **Only ever ask the user for the bot name.** Nothing else.
- **Never ask for the Telegram token in the terminal**, and **never re-request the
  AI key** — read it from the environment.
- **Never ask the user for a file path.** If they say “work in the `example`
  folder”, call `resolveTargetDirectory("… example")` — it finds it inside the
  project and never escapes it.
- **You cannot complete browser OAuth (Vercel).** Open it, then wait for the
  user's explicit confirmation. **Never poll in an infinite loop.**
- **Never bypass the ProofCast rule:** « Déploie » is blocked until a « Démo »
  (a real recorded proof) exists in the session.

## When something breaks

The bot writes its live reasoning (redacted) to `proofcast-live.md`. If the user
says **“lis le contexte de proofcast et corrige”**, read that file
(`getSessionContext()`) to see the state at the moment of the crash. ProofCast
also keeps project-scoped memory in `~/.proofcast/memory/` — **never delete it**;
its recent entries are injected into the AI prompt so mistakes aren't repeated.

## The public API you call

`generateBotFatherLink`, `saveToken`, `loadToken`, `startBot`, `generateFeature`,
`extractHtmlDocument`, `recordDemo`, `deployWithVercel`, `resolveTargetDirectory`,
`checkReadiness`, `getSessionContext`. Import from `proofcast` after `npm run build`.

Full details: [README.md](README.md).
