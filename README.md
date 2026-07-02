<div align="center">

# 🎬 ProofCast

### Proof before deploy.

**ProofCast records a video proof of your feature and ships it only after you've seen it.**
No blind `deploy to prod`. The engine is driven by *your* AI coding agent — you barely lift a finger.

[![CI](https://github.com/guillaumeCode2012/proofcast/actions/workflows/ci.yml/badge.svg)](https://github.com/guillaumeCode2012/proofcast/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A518.17-3c873a)
![TypeScript](https://img.shields.io/badge/TypeScript-ESM-3178c6)
![Tests](https://img.shields.io/badge/tests-75%20passing-2ea44f)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## TL;DR

You download a zip, open it in **Codex / Claude Code / Cursor**, and say **“configure proofcast”**.
The agent runs `npm run setup` and does everything. From then on you drive it from Telegram:

- **`Démo`** → the feature is generated, a **video proof adapted to it** is recorded, and the **MP4 lands in your chat**.
- **`Déploie`** → ships to Vercel production — but **`Déploie` is blocked until a `Démo`** proof exists. That single rule is the product.

## Table of contents

- [Why ProofCast](#why-proofcast)
- [Features](#features)
- [Quickstart (near-zero effort)](#quickstart-near-zero-effort)
- [For the AI agent — read this first](#-for-the-ai-agent--read-this-first)
- [Prerequisites](#prerequisites)
- [Setup — what happens on “configure proofcast”](#setup--what-happens-on-configure-proofcast)
- [Runtime — driving it from Telegram](#runtime--driving-it-from-telegram)
- [NAVIGATION](#navigation)
- [TRANSPARENCE & DEBUG](#transparence--debug)
- [APPRENTISSAGE](#apprentissage)
- [Architecture](#architecture)
- [Security](#security)
- [Project status (honest)](#project-status-honest)
- [API reference](#api-reference)
- [Development](#development)
- [License](#license)

---

## Why ProofCast

Shipping a feature you *believe* works is a leap of faith. ProofCast replaces the leap
with **evidence**: it drives the feature in a real browser, records what happens as an
MP4, and sends it to you. Only then can you deploy.

The engine enforces exactly one rule: **`Déploie` is blocked until a `Démo` (a real
recorded proof) has been produced in the current session.** Never bypass it — it *is*
the value proposition (proof before deployment).

## Features

- 🤖 **Piloted by any AI coding agent** (Codex / Claude Code / Cursor). No human CLI.
- 🔌 **Multi-provider AI**, never pre-chosen — Anthropic, OpenAI/Codex, or a custom provider. You pick the model; ProofCast never does.
- 🎥 **Adaptive video proof** — a signup page → it types an email + password and submits; a landing page → it scrolls through; you can script any steps. Delivered as **MP4**.
- 🚫 **Proof-before-deploy rule** — deployment stays blocked until a demo exists.
- 🧭 **Smart navigation** — “work in the `example` folder” resolves inside the project (traversal neutralized).
- 🪞 **Transparent** — real-time reasoning in `proofcast-live.md` for painless debugging.
- 🧠 **Learns across sessions** — project-scoped memory injected back into the prompt.
- 🔐 **Secure by default** — token git-ignored, secrets redacted everywhere, deploy args validated against injection.

## Quickstart (near-zero effort)

1. Unzip and open this folder in your AI coding agent (Codex / Claude Code / Cursor / …).
2. Tell the agent: **“configure proofcast”**. It reads [AGENTS.md](AGENTS.md), runs **`npm run setup`**, and handles the rest.
3. You only ever provide: **the bot name**, the **token** BotFather gives you, and you **finish the Vercel browser login** when asked.
4. In Telegram: send **`Démo`** for a video proof, then **`Déploie`** to ship.

> **Agents:** your runbook is [AGENTS.md](AGENTS.md) (mirrored in [CLAUDE.md](CLAUDE.md)). Start with `npm run setup` and follow the readiness report it prints.

## ⚠️ For the AI agent — READ THIS FIRST

These are hard rules; they exist because of capabilities you **do not** have.

- **You cannot complete a browser OAuth flow for the user.** For `vercel login`, open it, then **WAIT** for the user to confirm. Never poll in a loop, never proceed alone.
- **Ask the user for exactly ONE thing: the bot name.** Nothing else.
- **NEVER ask for the Telegram token in the terminal** — send a magic BotFather link; the user pastes the token to you.
- **NEVER ask for (or re-request) the AI provider API key** — it’s already in the environment.
- **NEVER ask the user for an absolute path** — use the path resolver ([NAVIGATION](#navigation)).
- **NEVER poll in an infinite loop** waiting on the user.

## Prerequisites

- **Node.js ≥ 18.17.**
- **One AI provider, chosen by the user** (ProofCast never pre-selects a model):
  - Anthropic: `ANTHROPIC_API_KEY` **+** `ANTHROPIC_MODEL`
  - OpenAI / Codex / OpenAI-compatible: `OPENAI_API_KEY` **+** `OPENAI_MODEL` (optional `OPENAI_BASE_URL`)
  - or force it with `PROOFCAST_AI_PROVIDER=anthropic|openai`
- **Chromium** for the recorder — installed automatically by `npm run setup`.
- **Vercel CLI** for deploys (`npm i -g vercel`, then `vercel login`).

`npm run setup` builds the engine, installs Chromium, and prints a **readiness report**
telling the agent exactly what’s left to do.

## Setup — what happens on “configure proofcast”

### 1. One command
```bash
npm run setup     # install + build + Chromium + readiness report
```

### 2. Ask the bot name (the only question)
> « Quel nom veux-tu pour ton bot ? »

### 3. Hand the user a BotFather link (never ask for the token yourself)
```ts
import { generateBotFatherLink, saveToken } from "proofcast";

const link = generateBotFatherLink(botName); // https://t.me/BotFather?text=%2Fnewbot%20<name>
// user creates the bot, pastes the token back to you:
saveToken(tokenFromUser);                    // validated + auto-gitignored (mode 600)
```

### 4. Confirm the AI provider (do NOT ask for the key)
Resolved from the environment. If missing, tell the user which variable to export — never prompt for the secret value.

### 5. Vercel authentication — STOP-AND-WAIT (critical)
1. Run `vercel login` via `child_process` to open the browser flow.
2. Tell the user: « Termine la connexion dans le navigateur, puis dis-moi **“j'ai terminé la connexion”**. »
3. **WAIT** for that confirmation. Do **not** poll, do **not** loop. You cannot complete this flow for the user.

### 6. Start the bot
```ts
import { startBot } from "proofcast";
await startBot(); // reads the saved token, resets proofcast-live.md, launches Telegraf
```

## Runtime — driving it from Telegram

| Command | What happens |
|---|---|
| **`Démo [description]`** | Generates the feature, records a **video proof adapted to it**, sends the **MP4** to the chat. |
| **`Déploie`** | Deploys to Vercel **production** — **blocked until a `Démo`** was produced this session. |

**The demo adapts to the feature** — it is *not* always a login form. A signup page → it
types an email + password and submits; a landing page → it scrolls through. The recording
runs on a local server that is **closed after** the demo, delivered as MP4.

## NAVIGATION

If the user says **“travaille sur le dossier example”**, **never** ask for the absolute path:

```ts
import { resolveTargetDirectory } from "proofcast";
const dir = await resolveTargetDirectory("travaille sur le dossier example");
```

- Scans the project (skipping `node_modules`, `.git`, `dist`, `build`, `.next`, dot-folders), picks the **shallowest** match, case-insensitively.
- It **always stays inside the project**: `../` and absolute paths in the hint are **neutralized**, never resolved as-is.
- No match → it creates and returns `./proofcast-workspace`.

## TRANSPARENCE & DEBUG

The bot writes its reasoning in real time to **`proofcast-live.md`** (reset each session).
If it crashes, the user says **“lis le contexte de proofcast et corrige”** — read that file
to see the state at the moment of the crash:

```ts
import { getSessionContext } from "proofcast";
const state = getSessionContext(); // full contents of proofcast-live.md
```

Everything written there is **redacted** first (tokens/keys → `***`). The file is git-ignored.

## APPRENTISSAGE

The bot **learns from its failures** via project-scoped memory at
**`~/.proofcast/memory/<hash>.md`** (two projects never mix). Its recent entries are
**automatically injected** into the AI prompt, so ProofCast avoids repeating mistakes.

- **Never delete this file between sessions.** It is the accumulated learning.
- Redacted before writing, truncated to the last ~200 entries.

## Architecture

```
onboarding ─┐                         ┌─ ai (multi-provider: Anthropic / OpenAI / custom)
            │   ┌──────── bot ────────┤─ video (Playwright → .webm → MP4, adaptive demo)
setup ──────┼──►│  Démo / Déploie     ├─ deployer (vercel --prod, injection-safe)
path-resolver   │  ProofCast rule     ├─ memory (proofcast-live.md + ~/.proofcast/memory)
                └─────────────────────┘
```

| Module | Responsibility |
|---|---|
| `onboarding` | Bot naming, BotFather link, token persistence (git-ignored) |
| `ai` | Multi-provider feature generation; HTML extraction |
| `video` | Local server + Playwright recording → MP4; adaptive demo |
| `deployer` | `vercel --yes --prod` via `execSync`, URL extraction, injection guard |
| `bot` | Telegraf; `Démo` / `Déploie`; the ProofCast rule |
| `path-resolver` | Safe, in-project folder resolution |
| `memory` | Live context + project-scoped learning, always redacted |
| `setup` | Readiness checks + next-action reporting |

## Security

- The Telegram token lives **only** in `.proofcast-config.json` (auto-gitignored, mode 600). Never printed.
- Provider API keys come **from the environment**; never printed, never re-requested.
- `proofcast-live.md` and the memory file are **redacted**; the live file is git-ignored; memory lives outside the repo.
- Deploy arguments are **validated against shell injection** before any command is built.

## Project status (honest)

| Area | Verified for real | Covered by mocks / gated |
|---|---|---|
| Video recording + MP4 transcode | ✅ real Chromium + ffmpeg | — |
| Navigation, memory, onboarding | ✅ real file ops | — |
| AI feature generation | — | mocked providers (`npm run test:live` for real) |
| Vercel deploy | — | mocked `execSync` (CLI not exercised here) |
| Telegram bot launch + send | — | mocked handlers; `bot.launch()` not run here |

The full real pipeline (real AI → real Telegram send → real deploy) is validated with
**`npm run test:live`** (gated behind `PROOFCAST_LIVE=1` + real credentials).

## API reference

| Module | Exports |
|---|---|
| `onboarding` | `generateBotFatherLink`, `saveToken`, `loadToken`, `maskToken` |
| `ai` | `generateFeature`, `extractHtmlDocument`, `createAnthropicProvider`, `createOpenAiProvider`, `resolveProvider` |
| `video` | `recordDemo`, `smartDemo`, `runDemoActions`, `autoFillDemoForm`, `hasDemoBeenGenerated` |
| `deployer` | `deployWithVercel`, `isVercelInstalled`, `extractDeploymentUrl` |
| `bot` | `startBot`, `buildBot`, `runDemoCommand`, `runDeployCommand` |
| `path-resolver` | `resolveTargetDirectory` |
| `memory` | `logLiveContext`, `getSessionContext`, `readMemory`, `writeMemory`, `redactSecrets` |
| `setup` | `checkReadiness`, `formatReadiness` |

## Development

```bash
npm install
npm run setup        # build + Chromium + readiness report
npm run build        # compile TypeScript → dist/
npm test             # 75 mocked/unit/integration tests (no network, no credentials)
npm run test:live    # real AI/Telegram/Vercel — gated behind PROOFCAST_LIVE=1 + real keys
```

Tests mock external services (AI, Vercel) and inject seams; Chromium + ffmpeg run for real.

## License

[MIT](LICENSE) © 2026 Guillaume Prévot
