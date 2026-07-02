# CLAUDE.md

This project (**ProofCast**) is meant to be configured **by you, the AI agent**,
with near-zero effort from the user.

👉 **Read [AGENTS.md](AGENTS.md) — it is the full runbook.**

TL;DR:

1. Run **`npm run setup`** and follow the readiness report it prints.
2. Ask the user for **only one thing: the bot name.** Never ask for tokens, API
   keys, or file paths.
3. For `vercel login` (browser), open it and **WAIT** for the user's explicit
   confirmation — you cannot complete OAuth, and you must never poll in a loop.
4. Start the bot with `startBot()`; the user then uses **`Démo`** / **`Déploie`**
   in Telegram. « Déploie » is blocked until a « Démo » proof exists.
5. On a crash, read `proofcast-live.md` (`getSessionContext()`); never delete
   `~/.proofcast/memory/`.
