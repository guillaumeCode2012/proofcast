<div align="center">

# ProofCast

### The autonomous AI agent that proves its work before it ships.

**Give it a feature in one sentence. ProofCast orchestrates a model to build it, drives it in a real browser, records the proof, and refuses to deploy until you've watched it work.**

Autonomous — never reckless. **Proof before deploy. No proof, no prod.**

![Tests](https://img.shields.io/badge/tests-101%20passing-2ea44f)
![Node](https://img.shields.io/badge/node-%E2%89%A518.17-3c873a)
![TypeScript](https://img.shields.io/badge/TypeScript-ESM-3178c6)
![License](https://img.shields.io/badge/license-MIT-blue)
![Driven by](https://img.shields.io/badge/driven%20by-Claude%20Code%20·%20Codex%20·%20Cursor-000)

[![Contribuer au projet](https://img.shields.io/badge/Contribuer_au_projet-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/guillaume_code) &nbsp; [![Suivre sur X](https://img.shields.io/badge/Suivre_@GuillaumeP86859-black?style=for-the-badge&logo=x&logoColor=white)](https://x.com/GuillaumeP86859)

[What it is](#what-proofcast-is) · [The loop](#the-loop) · [Everything inside](#everything-inside) · [Quickstart](#quickstart) · [Vision](#vision)

<br/>

<!-- Real run: `Démo` builds the feature, the recorded proof (real Chromium) lands in Telegram, then `Déploie`. -->
<img src="docs/proofcast-demo.gif" alt="ProofCast: a Démo command builds a payment page, records a real video proof of it working, and the MP4 lands in Telegram — then Déploie ships it." width="320" />

<sub>The clip inside the chat is a <b>real browser recording</b>, produced by ProofCast's own pipeline — not a mockup.</sub>

</div>

<br/>

> **An autonomous agent will happily ship code it never ran once.**
> ProofCast is the one built the other way around: it proves the work — on video, in a real browser — before anything reaches production.

---

## The world runs on agents now. Almost none of them verify.

Give an agent a goal and it acts: it writes, runs commands, deploys — on its own. The speed is the point. The danger is that it acts **on faith**. It reports a success it never checked, greenlights a build that never ran, and you discover the truth in production.

We automated *writing* software long before we automated *trusting* it. None of the usual signals close that gap:

- **Passing tests** prove the code the model chose to test behaves the way the model expected.
- **A green CI badge** proves it *built*, not that it *works*.
- **"I ran it, looks good"** vanishes the instant the terminal scrolls.
- **A screenshot** is a frozen frame; the bug lives in the interaction.

The missing layer was never *more autonomy*. It's **proof** — durable, watchable evidence that the actual feature does the actual thing, produced before the irreversible step, not apologized for after.

---

## What ProofCast is

ProofCast is **not** a plugin you bolt onto your IDE, and it's **not** a linter for AI output. It's a fully autonomous agent with its own memory, its own tools, and its own judgment — in the lineage of today's agentic systems, but defined by one discipline the others lack: **it stops to prove its work before it ships.**

You talk to it in plain language from Telegram. It configures itself, orchestrates the model *you* chose, builds the feature, runs it in a real browser, records the proof, and — only once you've seen that proof — deploys. Autonomy with a receipt.

---

## The loop

One command in. A proven, deployable feature out.

```
you → "Démo a signup page"
        │
        ▼
   ┌─────────────────────── ProofCast (autonomous) ───────────────────────┐
   │  orchestrate   your model builds the feature (memory-informed)        │
   │  run           serve it, drive it in real Chromium (Playwright)       │
   │  record        capture the real interaction → MP4                     │
   │  reason        narrate every step to proofcast-live.md                │
   └───────────────────────────────┬──────────────────────────────────────┘
                                    ▼
        ▶ proof.mp4 lands in your Telegram  ·  session marked demo-ready
                                    │
you → "Déploie"                     ▼
        └──────────►  proof exists?  ──►  vercel --prod  ──►  ✅ production URL
                          └─ no ─────►  ✋ blocked until a `Démo` exists
```

`Démo` and `Déploie` — French for *demo* and *deploy* — are the whole interface. **`Déploie` is blocked until a `Démo`** proof has been produced this session. No override. That gate is the agent's conscience.

<table>
<tr>
<th align="left">A typical autonomous agent</th>
<th align="left">ProofCast</th>
</tr>
<tr>
<td valign="top">

<pre>
you:    "add a signup page and ship it"
agent:  "Done ✅ — deployed to production."

you:    (opens the site, hopes)
        (it 500s on submit)
</pre>

</td>
<td valign="top">

<pre>
you:    "Démo a signup page"
agent:  🎬 building… 🎥 recording proof…
tg:     ▶ proof.mp4  ·  0:11
        (you watch it type an email and submit)
you:    "Déploie"
agent:  ✅ https://acme.vercel.app
</pre>

</td>
</tr>
</table>

---

## Everything inside

> **Brownfield, self-repair, sandbox, and dual-mode.** ProofCast works in **Brownfield mode** (it analyzes the target directory before writing any code), has a **self-repair loop of at most 3 attempts**, and runs everything inside an **isolated local Docker container, automatically cleaned up at the end of the run.** It now connects **two ways** — an Anthropic **API key** (fully autonomous) or **your existing agent subscription** (Claude Code, Zed…), where ProofCast is a pure proof engine driven through a small **CLI** (`proofcast run` / `proofcast generate`).

ProofCast isn't a demo recorder with extra steps. Recording is one organ; here's the whole body.

- **Autonomous onboarding.** It sets its own bot up end to end — hands you a BotFather link, validates and persists the token, wires the provider — asking you for exactly one thing.
- **Auto setup.** `npm run setup` installs dependencies, builds, installs Chromium, and prints a readiness report telling the driving agent precisely what's left.
- **AI orchestration.** It resolves your provider, folds memory into the prompt, generates the feature, and keeps the call bounded with a timeout and a retry — a slow or flaky model can't hang the loop.
- **Dual-mode: API key *or* your agent subscription.** Connect an Anthropic API key and ProofCast runs the whole loop itself (`generate` → prove → self-heal). Or keep your existing coding-agent subscription (Claude Code, Zed…): the agent writes the code, ProofCast is the pure proof engine — **zero LLM calls on its side**, chosen once via `aiMode` in `.proofcast-config.json`.
- **A scriptable CLI for agents.** `proofcast run <dir>` proves code that already exists; `proofcast generate "<desc>" <dir>` runs the autonomous pipeline (API-key mode). Both print **one line of JSON on stdout** (`success`, `proofPath`, typed `errors`, `attempts`) and set a **process exit code**, so a driving agent can loop "fix → re-run" on a clean, machine-readable contract.
- **A pure prover primitive.** The `proveCode` core boots a project, drives it in a real browser, and returns a typed `ProofReport` — with **no AI dependency at all** and the sandbox **always torn down**, so proving is the same whether ProofCast or your agent wrote the code.
- **Brownfield mode.** Point it at an existing project and it analyzes the codebase first — a file tree plus source, intelligently truncated to fit the model's budget — then *modifies* what's already there instead of regenerating from scratch.
- **Self-repair loop.** It runs the feature, watches for console errors, uncaught page exceptions, and HTTP 5xx, and feeds any failure back to the model to fix its own code — bounded to **3 attempts**, with a global timeout, never an infinite loop.
- **Docker isolation.** Every run executes inside a throwaway `node:20-alpine` container, so generated code can install and build without touching your machine — and the container is **always torn down** when the run ends, even on a crash.
- **Multi-provider, never pre-chosen.** Anthropic, OpenAI, Codex, or any compatible endpoint. Your environment picks the model; ProofCast never does, so you're never locked in.
- **Persistent memory.** Project-scoped, cross-session, redacted — and injected back into every prompt, so the agent learns from its own failures instead of repeating them.
- **Smart path resolution.** Say *"work in the example folder"* in plain language; it finds the right directory, case-insensitively, and refuses to escape the project.
- **Transparent reasoning.** It narrates every step to `proofcast-live.md` in real time. When something breaks, you read exactly where it stood — no black box.
- **Real-browser proof (Playwright).** It drives your feature in genuine Chromium and records the interaction as an MP4 — evidence you can watch, not a checkmark you have to trust.
- **Proof Before Deploy.** The one rule the engine will not let itself, or you, break: no deploy without a real proof this session.
- **Security by construction.** The token is git-ignored the instant it's written; secrets are redacted before they touch disk; deploy arguments are validated against injection; API keys are read from your environment and never requested.
- **Runs from your coding agent.** Claude Code, Codex, and Cursor drive it through a machine-readable runbook. You bootstrap once, then command it from your phone.

---

## Principles

- **Evidence over assertion.** A recording of it working beats a paragraph claiming it does.
- **Autonomy, with a checkpoint.** The agent does the whole job — and stops at the one place a mistake is expensive.
- **Deploy is earned, not assumed.** Production is gated on proof, and the gate has no bypass.
- **Your model, never ours.** ProofCast never pre-selects a provider or a model.
- **Secrets never travel.** Keys stay in your environment; anything hitting disk is redacted first.

---

## Architecture

```
                          ┌─  ai          orchestration: provider, memory, generation
        ┌──── bot ────────┤
setup ──┤  Démo / Déploie  ├─  video       Playwright → real Chromium → MP4 proof
        │  the deploy gate │
onboarding                 ├─  deployer    vercel --prod, injection-checked
        │                  │
path-resolver              └─  memory      live reasoning + cross-session learning, redacted
```

| Module | Responsibility |
|---|---|
| `bot` | Telegraf control surface; `Démo` / `Déploie`; enforces the deploy gate |
| `config` | Dual-mode config (`aiMode`: `API_KEY` / `AGENT_SUBSCRIPTION`); strict, no silent default |
| `ai` | Multi-provider orchestration (Anthropic / OpenAI / custom); memory injection; HTML extraction; brownfield change sets |
| `context-analyzer` | Brownfield analysis of an existing project (file tree + source, budget-aware truncation) for the model |
| `orchestrator` | `API_KEY` self-heal loop: generate → **prove** → fix, bounded retries + global timeout |
| `prover` | Pure "boot + drive + report" primitive (no AI): sandbox, Playwright, typed `ProofReport`, always torn down |
| `cli` | `proofcast run` / `proofcast generate`, routed by `aiMode`; JSON on stdout + exit code |
| `sandbox` | Isolated Docker container (`node:20-alpine`) per run, published port, always torn down |
| `video` | Local server + Playwright recording → MP4; feature-adaptive demo |
| `deployer` | `vercel --yes --prod`, URL extraction, argument injection guard |
| `onboarding` | Bot naming, BotFather link, token persistence (git-ignored) |
| `path-resolver` | Safe, in-project folder resolution |
| `memory` | Live reasoning + project-scoped learning, always redacted |
| `setup` | Readiness checks + next-action reporting |

---

## Quickstart

ProofCast is bootstrapped **by an AI coding agent**, then runs on its own.

1. **Open the project** in your agent — Claude Code, Codex, or Cursor.
2. **Say `configure proofcast`.** The agent reads [AGENTS.md](AGENTS.md), runs `npm run setup`, and drives the rest.
3. **Answer one question** — the bot's name — paste the token BotFather gives you, and finish the Vercel browser login when asked.
4. **Command it from Telegram:** `Démo` for a proof, `Déploie` to ship.

You bring **one AI provider** (the model is never pre-selected):

```bash
# Anthropic
export ANTHROPIC_API_KEY=...   ANTHROPIC_MODEL=...
# …or OpenAI / Codex / any OpenAI-compatible endpoint
export OPENAI_API_KEY=...      OPENAI_MODEL=...   # optional: OPENAI_BASE_URL
```

<details>
<summary><b>Prefer to wire it yourself?</b> The public API is small.</summary>

```ts
import { generateBotFatherLink, saveToken, startBot } from "proofcast";

const link = generateBotFatherLink(botName); // hand this to the user
saveToken(tokenFromUser);                    // validated + auto-gitignored (mode 600)
await startBot();                            // reads the token, resets live context, launches
```

`npm run setup` installs Chromium and prints a readiness report telling the agent exactly what's left.
</details>

---

## AI configuration — the dual-mode contract (CRITICAL)

Before ProofCast can prove anything, the driving agent picks **one of two modes** and writes it to `.proofcast-config.json`. ProofCast never asks the human directly — *you*, the agent, ask and persist the choice.

**Ask the user:** *"Veux-tu connecter ProofCast via une clé API Anthropic, ou via ton abonnement actuel (Claude Code, Zed, etc.) ?"*

### If the user chooses "Subscription" — `aiMode: "AGENT_SUBSCRIPTION"`

In this mode ProofCast makes **no LLM call whatsoever** — it only *proves* code that **you** write.

1. Write `"aiMode": "AGENT_SUBSCRIPTION"` into `.proofcast-config.json`. Do **not** write an `apiKey` field.
2. `@anthropic-ai/sdk` may stay in `package.json` — it is simply never called in this mode. No dependency change is required.
3. Every time you generate or modify code for the user: write the files directly into the project, then run **`proofcast run <dirPath>`**.
4. Read the JSON printed on **stdout** and the **exit code**:
   - **`exitCode === 0`** — success. The proof video is ready (its path is in the `proofPath` field of the JSON). You may offer a Vercel deploy.
   - **`exitCode !== 0`** — read the `errors` field of the JSON, fix the affected files **yourself** with your own subscription, then re-run `proofcast run <dirPath>`. Repeat until it passes, or until you judge it best to stop and tell the user.
5. ProofCast will never make an AI call in this mode — **all code repair is your responsibility as the agent.** The "fix → re-run" loop lives entirely on your side, exactly like any other shell command that fails.

### If the user chooses "API" — `aiMode: "API_KEY"`

1. Ask the user for the Anthropic API key.
2. Write `"aiMode": "API_KEY"` and `"apiKey": "..."` into `.proofcast-config.json`.
3. Use **`proofcast generate "<description>" <dirPath>`**: ProofCast generates, tests and self-repairs on its own (**up to 3 attempts**), with no intervention from you. Read the final JSON on stdout — it carries `success`, `attempts`, and `proofPath` — for the result.

ProofCast reads the API key straight from `.proofcast-config.json` (an explicit `ANTHROPIC_API_KEY` in the environment still wins). It reads the **model** from `ANTHROPIC_MODEL` in your environment — ProofCast never pre-selects one.

Both commands print **exactly one line of JSON on stdout** (never a raw stack trace) and set the process **exit code** to `0` on success / non-zero on failure, so you can script on them reliably. `generate` is refused with a clear error in `AGENT_SUBSCRIPTION` mode — in subscription mode, write the code yourself and use `proofcast run`.

---

## The agent's operating manual

Because ProofCast is operated by an AI agent, it ships that agent a short list of things it must **never** do — the things only a human can. Hard rules, mirrored in [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md).

- **You cannot complete a browser OAuth flow for the user.** For `vercel login`, open it, then **WAIT** for the user to say **"j'ai terminé la connexion."** Never poll in a loop; never proceed alone.
- **Ask the user for exactly ONE thing: the bot name.** Nothing else.
- **NEVER ask for the Telegram token in the terminal.** Hand over a BotFather link; the user pastes the token back to you.
- **NEVER ask for (or re-request) the AI provider API key.** It already lives in the environment.
- **NEVER poll in an infinite loop** waiting on a human.

### NAVIGATION

When the user says *"work in the `example` folder,"* **NEVER ask the user for an absolute path.** Resolve it safely:

```ts
import { resolveTargetDirectory } from "proofcast";
const dir = await resolveTargetDirectory("travaille sur le dossier example");
```

It scans the project (skipping `node_modules`, `.git`, `dist`, …), picks the shallowest case-insensitive match, and **stays inside the project** — `../` and absolute paths in the hint are neutralized, never resolved. No match? It creates and returns `./proofcast-workspace`.

### Transparent reasoning

The agent writes its reasoning, in real time, to **`proofcast-live.md`** (reset each session, every line redacted). When it crashes, the user says **"lis le contexte de proofcast et corrige"** and you read the state at the moment it fell over:

```ts
import { getSessionContext } from "proofcast";
const state = getSessionContext(); // full contents of proofcast-live.md
```

### Persistent memory

The agent learns across sessions from project-scoped memory at **`~/.proofcast/memory/<hash>.md`** (two projects never mix). Recent entries are injected back into the prompt, so mistakes aren't repeated — redacted before writing, capped so they never bloat a prompt.

> **Never delete this file between sessions.** It's the accumulated learning.

---

## Vision

Today, ProofCast is an autonomous agent that builds a **web feature, proves it in a real browser, and ships it to Vercel** — governed by proof before deploy.

The principle underneath is bigger than any single stack. As software starts to write and ship itself, the scarce resource stops being code and becomes **trust** — a reason to believe an autonomous action did what it claimed. The answer isn't slower agents. It's a receipt.

We think that becomes infrastructure: a world where *"the agent says it's done"* is replaced by *"here's the proof it's done"* — where every deploy, migration, and irreversible action an AI takes carries evidence a human can watch in seconds and a system can verify in milliseconds.

ProofCast is the first brick: the proof-of-work layer between an autonomous agent and the real world.

### Roadmap

Directions, not promises — clearly not shipped yet:

- **More proof surfaces** beyond the browser: API calls, CLIs, background jobs.
- **Assertions on the recording** — *"the page reached this state"* — so a proof can fail, not just be watched.
- **Shareable proofs** — a link a teammate or reviewer can open.
- **More deploy targets** beyond Vercel, behind the same gate.
- **Pluggable proof stores** so evidence is retained, searchable, and auditable.

---

## Honest status

ProofCast is young. Here's exactly what's exercised for real versus mocked — no asterisks.

| Area | For real | Mocked / gated |
|---|---|---|
| Real-browser recording + MP4 transcode | ✅ real Chromium + ffmpeg | — |
| Navigation · memory · onboarding | ✅ real file operations | — |
| AI orchestration | — | mocked providers (`npm run test:live` for real) |
| Vercel deploy | — | mocked `execSync` |
| Telegram send + bot launch | — | mocked handlers |

The full autonomous pipeline (real model → real Telegram → real deploy) runs under **`npm run test:live`**, gated behind `PROOFCAST_LIVE=1` and your own credentials.

---

## API reference

<details>
<summary>Full public surface</summary>

| Module | Exports |
|---|---|
| `onboarding` | `generateBotFatherLink`, `saveToken`, `loadToken`, `maskToken` |
| `config` | `loadConfig` — dual-mode `aiMode` (`API_KEY` / `AGENT_SUBSCRIPTION`) |
| `ai` | `generateFeature`, `extractHtmlDocument`, `parseBrownfieldResponse`, `createAnthropicProvider`, `createOpenAiProvider`, `resolveProvider` |
| `context-analyzer` | `analyzeTargetDirectory` |
| `orchestrator` | `executeAndHeal`, `writeFileChanges` (`API_KEY` self-heal loop) |
| `prover` | `proveCode`, `runBrowserChecks`, `spawnServerProcess`, `classifyBrowserErrors` |
| `cli` | `proofcast run` / `proofcast generate` (binaries) |
| `sandbox` | `startSandbox`, `stopSandbox` |
| `video` | `recordDemo`, `smartDemo`, `runDemoActions`, `autoFillDemoForm`, `hasDemoBeenGenerated` |
| `deployer` | `deployWithVercel`, `isVercelInstalled`, `extractDeploymentUrl` |
| `bot` | `startBot`, `buildBot`, `runDemoCommand`, `runDeployCommand` |
| `path-resolver` | `resolveTargetDirectory` |
| `memory` | `logLiveContext`, `getSessionContext`, `readMemory`, `writeMemory`, `redactSecrets` |
| `setup` | `checkReadiness`, `formatReadiness` |

</details>

---

## Development

```bash
npm install
npm run setup        # build + Chromium + readiness report
npm test             # 100+ unit/integration tests — no network, no credentials
npm run test:live    # real AI / Telegram / Vercel — gated behind PROOFCAST_LIVE=1
```

External services are mocked and injected; Chromium and ffmpeg run for real. Contributions welcome — the seams are built for it.

---

<div align="center">

**If an AI is going to ship your code, make it prove the code works first.**

Star the repo if you believe verification is the next layer of the AI stack.

[![Contribuer au projet](https://img.shields.io/badge/Contribuer_au_projet-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/guillaume_code) &nbsp; [![Suivre sur X](https://img.shields.io/badge/Suivre_@GuillaumeP86859-black?style=for-the-badge&logo=x&logoColor=white)](https://x.com/GuillaumeP86859)

[MIT](LICENSE) © 2026 Guillaume Prévot

</div>
