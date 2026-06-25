<p align="center">
  <img src="https://github.com/user-attachments/assets/def707b5-a3e5-4c45-870d-78d5b3fbde3d" alt="GeminiClaw" width="600" />
</p>

<h1 align="center">GeminiClaw</h1>

<p align="center">
  <strong>The first self-evolving agent runtime.</strong><br/>
  Twin-System architecture · Layered memory · Multi-model routing · Multi-agent delegation · Zero vendor lock-in
</p>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-BSL%201.1-blue" alt="License: BSL 1.1" />
  </a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-green" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/tests-680%20passing-brightgreen" alt="680 tests passing" />
</p>

---

## Why GeminiClaw?

GeminiClaw is a next-generation agent runtime that learns from every conversation and **rewrites its own code** to get better — while always keeping a rollback point.

It takes the best of both [OpenClaw](https://github.com/openclaw/openclaw) and [Hermes](https://github.com/NousResearch/hermes-agent), and adds what neither has.

| | OpenClaw | Hermes | **GeminiClaw** |
|---|---|---|---|
| **Language** | TypeScript | Python | TypeScript |
| **Agent loop + tools** | ✅ 30+ tools | ✅ 69 tools | ✅ 25 tools |
| **Multi-model routing** | ✅ | ✅ | ✅ |
| **Automatic fallback** | ⚠️ config-only | ✅ | ✅ |
| **Multi-agent delegation** | ❌ | ❌ | ✅ delegate_tasks + delegate_to |
| **Multi-channel** | ✅ 20+ channels | ✅ Telegram/Discord/Slack/WhatsApp/Signal | ✅ QQBot built-in · plugin system |
| **Plugin system** | ✅ heavy (40+ APIs) | ✅ lightweight (dir convention) | ✅ lightweight (hermes-style) |
| **Session persistence** | ✅ JSONL ⚠️ corruption risk | ✅ SQLite WAL | ✅ SQLite WAL |
| **Cross-session search** | ❌ | ✅ FTS5 + CJK trigram | ✅ FTS5 + CJK trigram |
| **Memory hierarchy** | ❌ flat file | ❌ flat curator | ✅ 4-layer L0-L3 topics |
| **Self-evolution** | ❌ | ❌ | ✅ **Twin-System** |
| **Skill evolution** | ❌ | ❌ | ✅ conversation → skill distillation |
| **Hot-swap without downtime** | ❌ | ❌ | ✅ git branch flow |
| **Rollback on regression** | ❌ | ❌ | ✅ circuit breaker |
| **Zero vendor lock-in** | ⚠️ | ✅ | ✅ |

---

## Core Innovation: Twin-System

> *"The only runtime that gets better while it runs."*

GeminiClaw is named after the Gemini twins — because it always runs in two states: **the live runtime** and **an evolution branch** being improved in the background.

<p align="center">
  <img src="https://github.com/user-attachments/assets/52b6e4f9-a106-4243-a6a6-4f0e3f7c027d" alt="Evolution Cycle" width="600" />
</p>

**The cycle:**
1. **Trace** — every conversation is recorded as a lightweight trace in SQLite
2. **Intent** — the Intent Engine analyzes traces and generates improvement proposals
3. **Mutate** — an LLM (via the built-in provider layer) rewrites code on a `evolution/<id>` branch
4. **Validate** — build + test (Level 1) + behavior comparison against live traces (Level 2)
5. **Switch** — squash merge to `main`, restart; the old commit is the rollback point

**Safety:** the Circuit Breaker monitors failure rate after every switch. If it spikes, the system reverts automatically and notifies you.

**Slot model (v2):** no file copying, no symlinks. `main` = live runtime. `evolution/xxx` = work-in-progress. Switching is just a git merge + process restart.

---

## Multi-Agent Delegation

GeminiClaw supports two forms of cross-agent delegation, both non-blocking (fire-and-forget):

**`delegate_tasks`** — spawn anonymous sub-agents for parallel background work. Ideal for browser scraping, multi-file processing, or independent research tasks. The parent agent continues immediately; results are pushed to the user when ready.

**`delegate_to`** — delegate to a **named specialist agent** defined in config. Each named agent has its own system prompt, model preference, and capabilities. Results are automatically pushed back to the user and injected into the session context.

```yaml
agents:
  - name: translator
    displayName: "翻译助手"
    capabilities: "中英互译，保持原文风格"
    model: "mcli/claude-sonnet-4-20250514"
    systemPrompt: "你是一个专业翻译..."

  - name: summarizer
    displayName: "摘要助手"
    capabilities: "长文摘要，提取关键信息"

  - name: coder
    displayName: "编程助手"
    capabilities: "代码生成、调试、重构"
```

The architecture: LifecycleBus event bus → SubagentRegistry tracking → AsyncExecutor background execution → ResultInjector push + context injection.

---

## Skill Evolution: Learning From Real Conversations

Beyond evolving its own *code*, GeminiClaw also distills reusable **skills** from the
conversations it actually has. The challenge is scale: a single long-running
session can span **days** and thousands of messages — the worst real case
observed was **5054 messages over 7.6 days (~960K tokens)**. Feeding that to a
reflector is both impossible (it blows every context window) and wrong (one
session is rarely one task — it's dozens of distinct goals interleaved over time).

### The problem with "summarise the middle"

The naïve fix — protect the head + tail and LLM-summarise the middle — collapses
under extreme length: the middle alone is hundreds of thousands of tokens, and a
lossy summary of 19 unrelated jobs can't yield one clean, crystallizable skill.

### The fix: decompose a session into independent tasks

GeminiClaw treats a very long session as a **set of independent tasks**, and lets
each task's execution be reflected on (and evolved) separately. Two stages, and
the raw transcript is **never** handed to an LLM wholesale:

1. **Distill (no LLM).** Keep only the high-signal turns: every human `user`
   message plus the **final** user-facing `assistant` reply of that turn — the
   intermediate tool-calling steps are dropped. On the 5054-message session this
   collapses **3.85M chars → 153K chars (~89K tokens, 4%)**.

2. **Segment (LLM, rolling).** Feed the distilled sequence to the
   [`ProviderRouter`](#multi-model-routing) and ask it to draw task boundaries,
   expressed as message-id intervals. Organised by day; each batch is capped at
   **150K tokens** (sized for a 200K window). If the distilled sequence exceeds
   the cap it is split into day-aligned batches, and each later batch is given
   the task list produced so far so the model **continues** the numbering across
   batches (rolling state). In practice real sessions fit in one batch, which
   gives the cleanest, coarsest grouping.

Each resulting task becomes its own `ReflectionCandidate`, carrying only the
verbatim message range `[startId, endId]` of that task — small, self-contained,
and free of any lossy middle summary. The reflector then evaluates **one clean
goal at a time**.

> **Engineering note.** The segmenter outputs compact pipe-delimited
> `TASK|index|startId|endId|count|title::summary` lines rather than a JSON array:
> a long array of similarly-shaped objects trips the router's repetition-loop
> detector and gets truncated mid-stream. One line per task keeps the output free
> of the repeated structural punctuation that triggers that heuristic.

**Verified end-to-end:** the 5054-message / 7.6-day session was decomposed into
**16 independent task candidates** (e.g. "fix ex-rights data", "migrate strategy
results DuckDB→SQLite", "build local→cloud scheduled sync", "design the v1.0
architecture doc"), each with a bounded 4K–12K-char transcript — no context-window
blow-up, no "All providers failed".

---

## Design Philosophy

> **"Protect the user's train of thought. Never disrupt it."**

Evolution happens in the background. It never interrupts your work.

| Principle | In practice |
|-----------|-------------|
| **Timing isolation** | Silent while you're actively chatting. Surfaces suggestions only after 5+ minutes idle — or when you ask. |
| **Context isolation** | All evolution confirmations happen in a **separate session**. Your current task's context is never polluted. |
| **Memory preservation** | Every pending intent stores a `why_now` field — what was observed, when, and what you were doing. Humans and AI both forget. The record doesn't. |
| **Deferral without loss** | You can always say "later". Cron follows up. Intents never silently disappear. |
| **Confidence gating** | LLM self-evaluates confidence after writing code. Low confidence (< 0.7) escalates risk level automatically. High-confidence, low-risk changes run fully automatically. |

---

## System Prompt Architecture

Inspired by [Hermes-agent](https://github.com/NousResearch/hermes-agent)'s `stable / context / volatile` three-tier design. The system prompt is assembled from three sources at startup — not hardcoded in a single file:

```
buildSystemPrompt("mcli/claude-opus-4-6")
  │
  ├── ~/.gemeniclaw/AGENT.md          ← identity + domain knowledge  (user-managed)
  │
  ├── Universal guidance              ← code constants, all models
  │     ├── TOOL_USE_ENFORCEMENT      — act, don't describe
  │     ├── PREREQUISITE_CHECKS       — gather context before acting
  │     └── GROUNDING_VERIFICATION   — claims backed by tool output
  │
  └── Model-family guidance           ← injected conditionally by detected family
        ├── claude  → lightweight mandatory-tool-use
        │             (targets the "answer from in-context memory" failure mode)
        └── gemini / gpt → strict NEVER-from-memory block
```

**Key design decisions:**

| Concern | Approach |
|---|---|
| Identity / domain knowledge | `~/.gemeniclaw/AGENT.md` — user-owned, not version-controlled |
| Behavioral rules | `src/system-prompt/constants.ts` — code constants, in git |
| Model-conditional injection | `detectModelFamily("mcli/claude-opus-4-6")` → `"claude"` |
| Per-agent identity | `~/.gemeniclaw/agents/{id}/AGENT.md` — unchanged |

The separation means behavioral rules survive prompt rewrites and can be unit-tested independently of `AGENT.md` content.

---

## Memory: Layered Topics

<p align="center">
  <img src="https://github.com/user-attachments/assets/67925cfd-9b60-4f04-9217-ad884115c265" alt="Layered Memory" width="600" />
</p>

A 4-layer topic hierarchy — the agent remembers everything important, but only pays attention cost for what's relevant.

```
Layer 0  Title + one-line summary          ~10 tokens    always in context
Layer 1  Condensed summary                ~200 tokens    loaded on relevance
Layer 2  Section overview                 ~500 tokens    loaded on deep relevance
Layer 3  Full detail                       ~2K tokens    loaded on explicit request
```

- **SQLite-backed** — persistent across restarts, no cloud dependency
- **Auto-compaction** — when a topic grows too large, the AI summarizes it down
- **Smart routing** — a lightweight classifier decides which topics matter per message
- **Triage** — new messages are classified: update existing topic, create new, or ignore

---

## Multi-Model Routing

<p align="center">
  <img src="https://github.com/user-attachments/assets/5b8f7ea7-a391-4771-995a-3b4b763ba112" alt="Multi-Model Routing" width="600" />
</p>

Configure multiple providers. GeminiClaw routes with ordered fallback — if the primary fails, it tries the next automatically.

```yaml
routing:
  default: "mcli/claude-opus-4-20250514"
  fallback:
    - "mcli/claude-sonnet-4-20250514"
    - "friday/gemini-2.5-flash"
```

Supported providers:
- **mcli** — Meituan internal LLM gateway (Anthropic-compatible, custom headers)
- **Friday** — Meituan AIGC platform (OpenAI-compatible, SSE streaming)
- **Anthropic** — Direct Claude API
- *Any OpenAI-compatible endpoint via config*

---

## Web Dashboard

GeminiClaw ships a local Web Dashboard served at `http://localhost:18888` alongside the API — no separate deploy needed.

<p align="center">
  <img src="https://github.com/user-attachments/assets/502dec60-f090-4675-898f-a4eadee6adde" alt="Web Dashboard — Space Dark" width="600" />
</p>

**Five pages:**

| Page | What it does |
|------|-------------|
| **Chat** | Streaming conversation with tool-call cards; session list with agent filter |
| **Sessions** | Manage all sessions — soft-archive, AI-generated titles, inline rename, bulk-clean |
| **Agents** | Browse agents; CONFIG / MEMORY / PROMPT / SKILLS tabs; per-agent model + skill override |
| **Runs** | Sub-agent run history |
| **Config** | Auth token, global AGENT.md, global MEMORY.md |

**Three built-in themes** — switchable in the sidebar, persisted to localStorage:

| Theme | Style |
|-------|-------|
| **Space Dark** (default) | Space anime aesthetic — amber/cyan on near-black, scan-line texture, monospace |
| **Day Command** | Light terminal — crisp amber-on-cream, high contrast |
| **Deep Sea** | Dark blue-green, teal accents |

<p align="center">
  <img src="https://github.com/user-attachments/assets/4d75fab1-81a2-4271-b196-9cb49b4e6ba7" alt="Web Dashboard — Day Command (light)" width="600" />
</p>

**Protected agents** — two system agents that cannot be archived:

- **双子星** — global default assistant; every new session is automatically linked to it (no new agent record created per session)
- **管理员** — system administrator; knows the skill file format and paths, authorized to install/update/delete skills via file tools

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/LiPingjiang/GeminiClaw.git
cd GeminiClaw

# 2. Install
pnpm install

# 3. Configure
cp config.example.yaml config.yaml
# Fill in your API keys and provider settings

# 4. Build web dashboard (optional)
pnpm --filter web build    # outputs to web/dist/ — served by the gateway

# 5. Run
pnpm dev          # development (tsx watch)
pnpm build && pnpm start   # production

# Web dashboard → http://localhost:18888
```

---

## API

```
POST /v1/agent/chat             — Chat (non-streaming)
POST /v1/agent/stream           — Chat (SSE streaming with tool events)
GET  /v1/health                 — Health check

# Sessions
GET    /v1/sessions                        — List active sessions (archived filtered)
POST   /v1/sessions                        — Create session
GET    /v1/sessions/:id/messages           — Get message history
DELETE /v1/sessions/:id                    — Soft-archive session
DELETE /v1/sessions/batch?maxMessages=N    — Bulk-archive sessions with < N messages
PATCH  /v1/sessions/:id/title              — Set title manually
POST   /v1/sessions/:id/title/generate     — AI-generate title from conversation

# Agents
GET    /v1/agents                          — List all agents
GET    /v1/agents/:id                      — Get agent detail
POST   /v1/sessions/:id/agents             — Link session to agent (reuses 双子星/管理员)
PATCH  /v1/agents/:id                      — Update name/description/status (protected agents reject archive)
GET    /v1/agents/:id/config               — Get per-agent config (skills, model, constants)
PATCH  /v1/agents/:id/config               — Update per-agent config
GET    /v1/agents/:id/system-prompt        — Get full structured system prompt with all layers

# Memory
GET    /v1/memory/global                   — Read ~/.gemeniclaw/AGENT.md + MEMORY.md
PATCH  /v1/memory/global                   — Write global memory files
GET    /v1/sessions/:id/memory             — Read agent AGENT.md + MEMORY.md for session
PATCH  /v1/sessions/:id/memory             — Write agent memory files

# Skills
GET    /v1/project-skills                  — List skills in skills/ directory
GET    /v1/models                          — List available models from all providers

# Evolution
GET  /v1/evolution/status       — Twin-system evolution state
POST /v1/evolution/run          — Trigger one evolution cycle manually
POST /v1/evolution/intents      — Add user intent
GET  /v1/evolution/candidates   — Peek at intent queue
GET  /v1/evolution/approvals    — List pending approvals
POST /v1/evolution/approvals/:id/approve  — Approve a high-risk intent
POST /v1/evolution/approvals/:id/reject   — Reject an intent

GET  /v1/skill-evolution/status — Skill evolution engine state
POST /v1/skill-evolution/scan   — Trigger skill extraction from conversations
GET  /v1/trace/live             — SSE live trace stream (for gc watch TUI)
```

### Chat (non-streaming)

```json
// Request
{
  "message": "Hello!",
  "sessionId": "optional-session-id",
  "model": "mcli/claude-sonnet-4-20250514"
}

// Response
{
  "response": "Hello! How can I help?",
  "sessionId": "abc-123",
  "model": "mcli/claude-sonnet-4-20250514"
}
```

### Stream (SSE)

```json
// Request
{ "message": "Translate this to English", "sessionId": "optional" }
```

Response is `text/event-stream` with typed events: `turn_start`, `message_delta`, `tool_start`, `tool_end`, `turn_end`, `agent_end`.

---

## Configuration

```yaml
server:
  port: 3000
  host: "0.0.0.0"
  authToken: "your-secret-token"

providers:
  - name: mcli
    type: mcli
    apiKey: "your-key"
    baseUrl: "https://mcli.sankuai.com"
    extraHeaders:
      X-Working-Dir: "/your/project"
    models: [claude-opus-4-20250514, claude-sonnet-4-20250514]

routing:
  default: "mcli/claude-opus-4-20250514"
  fallback: ["mcli/claude-sonnet-4-20250514"]

memory:
  strategy: layered   # buffer (dev) or layered (production)

agents:
  - name: translator
    displayName: "翻译助手"
    capabilities: "中英互译"
    systemPrompt: "你是专业翻译..."
  - name: summarizer
    displayName: "摘要助手"
    capabilities: "长文摘要"

channels:
  qqbot:
    enabled: true
    appId: "your-app-id"
    clientSecret: "your-secret"
    mode: "websocket"   # or "webhook"
```

---

## Directory Layout

```
src/
├── index.ts              ← entry point (config load + server start)
├── agent/                ← AgentLoop (tool orchestration, parallel calls, budget)
├── server/               ← Fastify HTTP server + routes (serves API + web/dist/)
├── providers/            ← LLM provider adapters (Anthropic, mcli, Friday)
├── memory/               ← session + layered long-term memory (SQLite)
├── system-prompt/        ← layered system prompt builder (model-conditional injection)
│   ├── builder.ts        ← buildSystemPrompt(routingDefault?) — main entry
│   ├── constants.ts      ← behavioral guidance blocks (code-owned, version-controlled)
│   └── families.ts       ← model family detection (claude / gemini / gpt / unknown)
├── tools/                ← 25 built-in tools (exec, read, write, browser, delegate_to...)
├── multi-agent/          ← cross-agent delegation (mailbox, lifecycle-bus, result-injector)
├── agents/               ← agent repository (SQLite-backed, DB-tracked UUIDs)
├── channels/             ← channel adapters (QQBot WebSocket/Webhook)
├── twin-system/          ← self-evolution engine (factory DI + all components)
├── skill-evolution/      ← conversation → skill distillation engine
├── skills/               ← skill loader (scans skills/ dir, injects into system prompt per turn)
├── evolution-core/       ← evolution orchestrator + engine
├── mesh/                 ← agent mesh (bus, pool, receptionist)
├── guidance/             ← agent gate + guidance layer
├── cli/                  ← TUI client (gc watch)
└── config/               ← config loader (Zod schema, reads config.yaml)

web/                      ← Local Web Dashboard (React 19 + Vite, served at :18888)
├── src/
│   ├── pages/            ← Chat / Sessions / Agents / Runs / Config
│   ├── components/       ← Sidebar (theme switcher), DiffBlock, MarkdownField...
│   └── lib/api.ts        ← REST + SSE client, theme persistence
└── dist/                 ← built output (served as SPA by Fastify static)

skills/                   ← Skill definitions (each skill: skills/<name>/SKILL.md)
scripts/
├── replay-session.ts          ← replay a session turn against Claude, save prompt + response
├── verify-prompt-behavior.mjs ← A/B compare two system prompts (no tools, fast)
└── verify-prompt-full.mjs     ← A/B compare with real bash tool execution (complete)
```

---

## Current Status

| Feature | Status |
|---------|--------|
| Multi-provider routing (mcli / Friday / Anthropic) | ✅ |
| Ordered fallback with automatic retry | ✅ |
| Bearer auth | ✅ |
| Non-streaming + SSE streaming | ✅ |
| AgentLoop with parallel tool calls + iteration budget | ✅ |
| 25 built-in tools (exec, read, write, edit, browser, web_search, delegate_to...) | ✅ |
| Buffer memory (sliding window) | ✅ |
| Layered memory (SQLite, 4-layer topics) | ✅ |
| Multi-agent delegation: delegate_tasks (anonymous, parallel) | ✅ |
| Multi-agent delegation: delegate_to (named agents, config-driven) | ✅ |
| Named agent templates with dynamic tool description injection | ✅ |
| Result push + session context injection (ResultInjector) | ✅ |
| QQ Bot channel (WebSocket + Webhook modes) | ✅ |
| Twin-System: SlotManager + SafetyGuard + EvolutionPipeline | ✅ |
| Evolution: Mutator + Validator + Persistence + IntentAggregator | ✅ |
| Evolution: SchedulerRunner + PostSwitchMonitor | ✅ |
| Evolution: ApprovalGate + auto-approve by risk level | ✅ |
| Skill Evolution: conversation → ReflectionCandidate | ✅ |
| Skill Evolution: long-session task decomposition (distill + rolling segment) | ✅ |
| System prompt: 3-layer architecture (identity / universal / model-family) | ✅ |
| System prompt: model-family detection + conditional guidance injection | ✅ |
| Dev tools: session replay (`scripts/replay-session.ts`) | ✅ |
| Dev tools: system prompt A/B verification with real bash tools | ✅ |
| Dev tools: generalized replay system (`src/replay/`) | 🔧 planned |
| **Web Dashboard** (React 19 + Vite, served at :18888) | ✅ |
| Web: Chat page — SSE streaming, tool-call cards, session list | ✅ |
| Web: Sessions — soft-archive, AI title generation, inline rename | ✅ |
| Web: Agents — CONFIG / MEMORY / PROMPT / SKILLS tabs, per-agent model + skill override | ✅ |
| Web: Config — global AGENT.md / MEMORY.md with markdown preview/edit | ✅ |
| Web: 3 themes — Space Dark / Day Command (light) / Deep Sea | ✅ |
| Protected agents: 双子星 (default) + 管理员 (skill admin), non-archivable | ✅ |
| Per-agent config: skills whitelist, model override, constants | ✅ |
| Skill management via 管理员 agent (file-tool authorized, no restart needed) | ✅ |
| 680 tests across 66 files, all passing | ✅ |

---

## Build & Test

```bash
pnpm install        # install dependencies
pnpm dev            # development mode (tsx watch)
pnpm build          # compile TypeScript
pnpm test           # run all tests (vitest, 680 tests, 66 files)
pnpm start          # production (node dist/index.js)
```

---

## Development Tools

### Session Replay

Replay a specific turn of a conversation against Claude and inspect the exact prompt sent and response received. Useful for diagnosing unexpected agent behavior.

```bash
# Replay session up to message id 844, save to /tmp/
npx tsx scripts/replay-session.ts <sessionId> <upToMsgId>

# Example
npx tsx scripts/replay-session.ts 5fbb3c60-17c6-43bd-b503-04abfc8c250b 844
# Output saved to /tmp/replay-5fbb3c60-msg844.json
# Fields: request.systemPrompt, request.messages, responseText, response.usage
```

**Limitation:** Tool call outputs are not currently persisted to the database (known issue). The replay context will be missing tool results from previous turns, which means `contextFaithfulness` may be lower than the original session. This is reported in the output.

### System Prompt A/B Verification

Verify that a change to the system prompt produces the expected behavior change. Two variants:

**Fast (no tool execution):**
```bash
# Compare old vs new system prompt — text only, ~5s
node scripts/verify-prompt-behavior.mjs
```

**Complete (with real bash tool execution):**
```bash
pnpm build   # required: loads from dist/

# Runs 4 scenarios in parallel:
#   Scenario A — Claude has file content in tool_result context, asks for 20 lines
#   Scenario B — No prior context, asks for 20 lines from scratch
# Each scenario: old prompt vs new prompt
node scripts/verify-prompt-full.mjs
# Output saved to /tmp/verify_full_v2.json
```

The script runs assertions and prints a verdict:
```
✅ [A] 新prompt 重新调了 bash
✅ [A] 新prompt bash 读到 ≥15 行代码
✅ [A] 新prompt 最终回复 ≥15 行
✅ [B] 两个 prompt 都拿到了 ≥20 行代码
结论: ✅ 验证通过
```

### Planned: Generalized Replay System

A unified `src/replay/` module is planned (Task #3) that will combine session replay and A/B prompt comparison into a single CLI:

```bash
# Future API (not yet implemented)
npx tsx src/replay/index.ts \
  --session 5fbb3c60 \
  --at 844 \
  --compare \       # prompt A = AGENT.md only, prompt B = current buildSystemPrompt()
  --tools           # execute real bash commands
```

It will report `contextFaithfulness` (0–1) alongside behavior diffs, making missing tool outputs explicit rather than silently partial.

---

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full Twin-System design, evolution engine internals, and the philosophy behind GeminiClaw.

---

## Licensing

GeminiClaw is licensed under the [Business Source License 1.1](LICENSE).

- **Free** for personal and evaluation use
- **Commercial use** requires a license — contact [pingjiang.li@outlook.com](mailto:pingjiang.li@outlook.com)
- Converts to **Apache 2.0** on 2030-05-05
