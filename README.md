<div align="center">

# ProofCast

### The trust layer for autonomous software agents.

**Agents can write code and ship it. ProofCast makes them prove it works first — on video, in a real browser — before anything reaches production.**

![Tests](https://img.shields.io/badge/tests-passing-2ea44f)
![Node](https://img.shields.io/badge/node-%E2%89%A518.17-3c873a)
![TypeScript](https://img.shields.io/badge/TypeScript-ESM-3178c6)
![License](https://img.shields.io/badge/license-MIT-blue)
![Driven by](https://img.shields.io/badge/driven%20by-Claude%20Code%20·%20Codex%20·%20Cursor-000)

[![Contribute](https://img.shields.io/badge/Contribute-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/guillaume_code) &nbsp; [![Follow on X](https://img.shields.io/badge/Follow_@GuillaumeP86859-black?style=for-the-badge&logo=x&logoColor=white)](https://x.com/GuillaumeP86859)

[The problem](#the-problem) · [The solution](#the-solution) · [How it works](#how-it-works) · [Architecture](#architecture) · [Installation](#installation) · [Status](#current-status)

<br/>

<img src="docs/proofcast-demo-payment.gif" alt="Inside a phone: ProofCast builds a payment page, records a real video proof of the checkout working in a real browser, sends it in Telegram — then a Déploie command ships it live." width="300" />

<sub>Real recording, real Chromium, real pipeline. Not a mockup.</sub>

</div>

<br/>

```
you:        "Build a checkout page"

ProofCast:  Build → Run → Record → Prove → Deploy
            ────────────────────────────────────
            🧠 generates the code
            📦 boots it in an isolated container
            🌐 drives it in real Chromium
            🎥 records the interaction as MP4
            ✅ only then — deploys
```

---

## The problem

Autonomous agents can write and ship software now. That part is solved. What's missing is a reason to believe the result actually works.

An agent can say **"Done ✅"** while:
- the feature doesn't do what was asked
- the button throws on click
- the signup flow 500s on submit
- the deploy is broken and nobody looked

None of the usual signals close that gap:

| Signal | What it actually proves |
|---|---|
| Passing tests | The code the model chose to test behaves as the model expected |
| Green CI | It *built* — not that it *works* |
| "I ran it, looks good" | Nothing, the moment the terminal scrolls |
| A screenshot | One frozen frame; the bug lives in the interaction |

We automated *writing* software long before we automated *trusting* it. That gap doesn't close with a faster or smarter agent — it closes with evidence.

---

## The solution

**Agents create. ProofCast proves.**

ProofCast sits between the agent and production. It takes the instruction, builds the feature, runs it for real, records what happened, and only lets a deploy through if the proof exists. No proof, no deploy — no exceptions, no override.

It isn't a linter, a test runner, or a screen recorder bolted onto a pipeline. It's an autonomous agent in its own right — with memory, tools, and judgment — defined by the one discipline most agents skip: **it stops to prove its work before it ships.**

---

## How it works

```
 1. BUILD     natural-language request → generated feature (multi-provider LLM)
 2. RUN       boots the project inside an isolated Docker container
 3. OBSERVE   drives it in real Chromium — clicks, fills forms, navigates
 4. RECORD    captures the interaction and transcodes it to MP4
 5. VERIFY    console errors, page exceptions, HTTP 5xx → self-repair (≤ 3 attempts)
 6. DEPLOY    only if a passing proof exists this session — otherwise: blocked
```

```
"Démo a signup page"
        │
        ▼
┌──────────────────── ProofCast (autonomous) ────────────────────┐
│  orchestrate   the model builds the feature (memory-informed)   │
│  run           serve it, drive it in real Chromium              │
│  record        capture the real interaction → MP4               │
│  verify        console errors / exceptions / 5xx → self-repair  │
└─────────────────────────────┬────────────────────────────────────┘
                               ▼
        ▶ proof.mp4 lands in Telegram · session marked demo-ready
                               │
"Déploie"                     ▼
        └──────► proof exists? ──► deploy ──► ✅ production URL
                     └─ no ────► ✋ blocked until a proof exists
```

---

## Why ProofCast is different

- **Real-browser proof, not a claim.** Every proof is a genuine Chromium session (Playwright), recorded and transcoded to MP4 — something you watch, not a checkmark you trust.
- **Docker isolation.** Every run boots in a throwaway `node:20-alpine` container. Generated code never touches your machine, and the container is always torn down — success, failure, or crash.
- **Self-repair loop.** Runtime errors are fed back to the model automatically, bounded to 3 attempts with a global timeout. Never an infinite loop.
- **Proof-gated deployment.** The deploy gate is a fail-closed guard: if the gate itself breaks, the default is *no deploy*, never a silent pass.
- **Persistent memory.** Project-scoped, redacted, injected back into every prompt — so the agent learns from its own past failures instead of repeating them.
- **Multi-provider, never pre-chosen.** Anthropic, OpenAI, or any compatible endpoint. Your environment picks the model; ProofCast never does.
- **Works alongside your existing agent.** ProofCast ships a machine-readable runbook (`AGENTS.md`) that Claude Code, Codex, and Cursor read directly — it bootstraps once, then runs on its own.

---

## Example workflow

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

`Démo` and `Déploie` — French for *demo* and *deploy* — are the whole interface. **`Déploie` is blocked until a `Démo` proof exists this session.** No override.

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
| `config` | Config (`apiKey` required); strict, no silent default |
| `ai` | Multi-provider orchestration (Anthropic / OpenAI / custom); memory injection; HTML extraction; brownfield change sets |
| `context-analyzer` | Brownfield analysis of an existing project (file tree + source, budget-aware truncation) for the model |
| `orchestrator` | Self-heal loop: generate → **prove** → fix, bounded retries + global timeout |
| `prover` | Pure "boot + drive + report" primitive (no AI): sandbox, Playwright, typed `ProofReport`, always torn down |
| `tools` | Jailed, bounded agent tools: `fs_*`, `shell_run` (sandbox-only), `browser_*`, `http_fetch` + SSRF url-guard; `save_skill`/`remember_preference`; `git_commit`/`github_open_pr`; `pilot_agent` |
| `agent` / `planner` | Bounded planner→tool→observe loop (`runAgent`) with a fail-closed guard; multi-provider LLM planner |
| `skills` | Self-written reusable skills (`SkillStore`, `runSkill`) + user preference memory |
| `gate` | Reusable proof-before-deploy guard (`createProofGate`) for irreversible tools |
| `github` | `git`/`gh` ops + the proof-gated PR (`openProvenPullRequest`) |
| `webhook` / `daemon` | HMAC-verified Sentry/GitHub webhook → `runIssueToPr` (fix → prove → gated PR) + scheduler |
| `cli` | `proofcast run` / `proofcast generate`; JSON on stdout + exit code |
| `sandbox` | Isolated Docker container (`node:20-alpine`) per run, published port, always torn down |
| `video` | Local server + Playwright recording → MP4; feature-adaptive demo |
| `deployer` | `vercel --yes --prod`, URL extraction, argument injection guard |
| `onboarding` | Bot naming, BotFather link, token persistence (git-ignored) |
| `path-resolver` | Safe, in-project folder resolution |
| `memory` | Live reasoning + project-scoped learning, always redacted |
| `setup` | Readiness checks + next-action reporting |

---

## Security

ProofCast runs untrusted, model-generated code. It's built to fail closed.

- **Docker sandbox.** Generated code is installed, built and run inside an isolated `node:20-alpine` container — never on your host — and the container is always torn down, even on a crash.
- **No host execution.** The `shell_run` tool only ever runs inside the sandbox. There is no code path from a model decision to a command on your machine.
- **SSRF protection.** The browser and HTTP tools refuse private, loopback, and cloud-metadata hosts (`169.254.169.254`, `localhost`, `10/8`, …) by default — a model-driven fetch can't be steered into your internal network.
- **Secrets redaction.** Tokens and keys are stripped before anything touches disk — logs, live reasoning (`proofcast-live.md`), and persistent memory are all redacted.
- **Bounded loops, everywhere.** The self-repair loop, the planner→tool loop, and every AI call carry a hard step budget and a wall-clock timeout. Nothing runs `while (true)`.
- **Fail-closed deployment.** The deploy gate is a guard that vetoes irreversible actions *before* they execute. If the guard itself throws, the default is refusal — a broken gate can never let a deploy through.
- **Git-ignored secrets.** `.proofcast-config.json` is added to `.gitignore` the instant it's written, mode `0600` on POSIX.

---

## Installation

ProofCast is bootstrapped **by an AI coding agent**, then runs on its own.

```bash
git clone https://github.com/guillaumeCode2012/proofcast.git
cd proofcast
npm install
npm run setup   # build + install Chromium + readiness report
```

Then, from your coding agent (Claude Code, Codex, Cursor):

1. **Open the project** and say `configure proofcast`. It reads [AGENTS.md](AGENTS.md) and drives the rest.
2. **Answer one question** — the bot's name — paste the token BotFather gives you, and finish the Vercel browser login when asked.
3. **Command it from Telegram:** `Démo` for a proof, `Déploie` to ship.

Bring one AI provider (the model is never pre-selected):

```bash
# Anthropic
export ANTHROPIC_API_KEY=...   ANTHROPIC_MODEL=...
# …or OpenAI / any OpenAI-compatible endpoint
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
</details>

<details>
<summary><b>Prefer the CLI?</b> Same engine, no Telegram.</summary>

```bash
# Write your provider key into .proofcast-config.json first, then:
proofcast generate "add a reset button" ./my-app   # generate → prove → self-heal
proofcast run ./my-app                             # (re-)prove code that already exists
```

Both commands print exactly one line of JSON on stdout (`success`, `proofPath`, typed `errors`, `attempts`) and set a process exit code — script on them reliably. Exact CLI contract: **`proofcast run <dirPath>`** proves code that already exists; **`proofcast generate "<description>" <dirPath>`** generates, tests and self-repairs it, calling ProofCast's own AI provider directly — it never hands the job off to another agent.
</details>

---

## AI configuration (CRITICAL)

ProofCast is an autonomous agent, not an intermediary or a wrapper around another agent. Before it can prove anything, the driving agent asks the user for their AI provider API key and persists it to `.proofcast-config.json`. ProofCast never asks the human directly — *you*, the agent, ask and persist it.

1. Ask the user for their API key (Anthropic, OpenAI, or a compatible endpoint).
2. Write `"apiKey": "..."` into `.proofcast-config.json`.
3. Use `proofcast generate "<description>" <dirPath>`: ProofCast generates, tests and self-repairs on its own (**up to 3 attempts**), calling its own AI provider directly — no intervention from you. Read the final JSON on stdout — it carries `success`, `attempts`, and `proofPath` — for the result.
4. `proofcast run <dirPath>` remains available to (re-)prove code that already exists, without generating anything — it prints the same JSON contract on stdout.

ProofCast reads the API key straight from `.proofcast-config.json` (an explicit `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in the environment still wins). It reads the **model** from `ANTHROPIC_MODEL` / `OPENAI_MODEL` in your environment — ProofCast never pre-selects one.

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

## Current status

ProofCast is young. Here's exactly what's real versus mocked in the test suite — no asterisks.

**Implemented and tested for real:**
- Real-browser recording (Playwright + Chromium) and MP4 transcoding (ffmpeg)
- Docker sandbox lifecycle (start, boot-wait, teardown)
- Persistent, redacted memory and live reasoning
- Path resolution, onboarding, and the readiness/setup pipeline
- The CLI contract (`proofcast run` / `proofcast generate`) and the proof-before-deploy gate
- The bounded agent loop, tool belt, and SSRF guards

**In progress / exercised via mocks in the default test run:**
- AI provider calls (mocked by default; real under `npm run test:live`)
- Vercel deploy (mocked `execSync`; real under `npm run test:live`)
- Telegram send + bot launch (mocked handlers; real under `npm run test:live`)

The full pipeline — real model, real Telegram, real deploy — runs under `npm run test:live`, gated behind `PROOFCAST_LIVE=1` and your own credentials.

---

## Vision

Today, ProofCast is an agent that builds a web feature, proves it in a real browser, and ships it — governed by proof before deploy.

The principle underneath is bigger than any one stack. As software starts to write and ship itself, the scarce resource stops being code and becomes **trust** — a reason to believe an autonomous action did what it claimed.

**ProofCast is building the verification layer for the autonomous software economy** — a world where *"the agent says it's done"* is replaced by *"here's the proof it's done,"* and every deploy, migration, or irreversible action an AI takes carries evidence a human can watch in seconds and a system can verify in milliseconds.

Directions, not promises — clearly not shipped yet:

- **More proof surfaces** beyond the browser: API calls, CLIs, background jobs.
- **Assertions on the recording** — *"the page reached this state"* — so a proof can fail, not just be watched.
- **Shareable proofs** — a link a teammate or reviewer can open.
- **More deploy targets** beyond Vercel, behind the same gate.
- **Pluggable proof stores** so evidence is retained, searchable, and auditable.

---

## Development

```bash
npm install
npm run setup        # build + Chromium + readiness report
npm test             # unit/integration tests — no network, no credentials
npm run test:live    # real AI / Telegram / Vercel — gated behind PROOFCAST_LIVE=1
```

External services are mocked and injected; Chromium and ffmpeg run for real. Contributions welcome — the seams are built for it.

<details>
<summary>Full public API surface</summary>

| Module | Exports |
|---|---|
| `onboarding` | `generateBotFatherLink`, `saveToken`, `loadToken`, `maskToken` |
| `config` | `loadConfig` — required `apiKey` |
| `ai` | `generateFeature`, `extractHtmlDocument`, `parseBrownfieldResponse`, `createAnthropicProvider`, `createOpenAiProvider`, `resolveProvider` |
| `context-analyzer` | `analyzeTargetDirectory` |
| `orchestrator` | `executeAndHeal`, `writeFileChanges` (self-heal loop) |
| `prover` | `proveCode`, `runBrowserChecks`, `spawnServerProcess`, `classifyBrowserErrors` |
| `tools` | `ToolRegistry`, `createFsTools`, `createShellTool`, `createBrowserTools`, `createHttpTool`, `assertSafeHttpUrl`, `createSkillTools`, `createPreferenceTool`, `createGitHubTools`, `createPilotTool` |
| `agent` / `planner` | `runAgent`, `createLlmPlanner`, `parsePlannerDecision` |
| `skills` | `SkillStore`, `runSkill`; `writePreference`, `readPreferenceBlock` |
| `gate` / `github` | `createProofGate`; `commitAll`, `openPullRequest`, `openProvenPullRequest` |
| `webhook` / `daemon` | `startWebhookServer`, `verifyWebhookSignature`; `runIssueToPr`, `createScheduler` |
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

<div align="center">

**If an AI is going to ship your code, make it prove the code works first.**

Star the repo if you believe verification is the next layer of the AI stack.

[![Contribute](https://img.shields.io/badge/Contribute-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/guillaume_code) &nbsp; [![Follow on X](https://img.shields.io/badge/Follow_@GuillaumeP86859-black?style=for-the-badge&logo=x&logoColor=white)](https://x.com/GuillaumeP86859)

[MIT](LICENSE) © 2026 Guillaume Prévot

</div>
