<p align="center">
  <img src="https://github.com/user-attachments/assets/def707b5-a3e5-4c45-870d-78d5b3fbde3d" alt="GeminiClaw" width="600" />
</p>

<h1 align="center">GeminiClaw</h1>

<p align="center">
  <strong>The first self-evolving agent runtime.</strong><br/>
  Twin-System architecture · Layered memory · Multi-agent · Multi-model routing · Zero vendor lock-in
</p>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-BSL%201.1-blue" alt="License: BSL 1.1" />
  </a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-green" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/tests-553%20passing-brightgreen" alt="553 tests passing" />
</p>

---

## Why GeminiClaw?

GeminiClaw is a next-generation agent runtime that learns from every conversation and **rewrites its own code** to get better — while always keeping a rollback point.

It takes the best of both [OpenClaw](https://github.com/openclaw/openclaw) and [Hermes](https://github.com/NousResearch/hermes-agent), and adds what neither has.

| | OpenClaw | Hermes | **GeminiClaw** |
|---|---|---|---|
| **Language** | TypeScript | Python | TypeScript |
| **Agent loop + tools** | ✅ 30+ tools | ✅ 69 tools | ✅ 25+ tools |
| **Multi-agent** | ⚠️ subagents | ⚠️ subagents | ✅ per-user agents + Agent Gate |
| **Multimodal (image)** | ✅ | ✅ | ✅ full pipeline |
| **Multi-model routing** | ✅ | ✅ | ✅ |
| **Automatic fallback** | ⚠️ config-only | ✅ | ✅ |
| **Multi-channel** | ✅ 20+ channels | ✅ Telegram/Discord/Slack/WhatsApp/Signal | ✅ QQBot built-in · plugin system |
| **Plugin system** | ✅ heavy (40+ APIs) | ✅ lightweight (dir convention) | ✅ lightweight (hermes-style) |
| **Session persistence** | ✅ JSONL ⚠️ corruption risk | ✅ SQLite WAL | ✅ SQLite WAL |
| **Cross-session search** | ❌ | ✅ FTS5 + CJK trigram | ✅ FTS5 + CJK trigram |
| **Memory hierarchy** | ❌ flat file | ❌ flat curator | ✅ 4-layer L0-L3 topics |
| **Memory search tool** | ❌ | ⚠️ | ✅ `memory_search` across all sources |
| **Self-evolution** | ❌ | ❌ | ✅ **Twin-System** |
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
2. **Intent** — Intent Sources analyze traces, memory topics, and upstream diffs to generate improvement proposals
3. **Mutate** — an LLM (via the built-in provider layer) rewrites code on an `evolution/<id>` branch
4. **Validate** — build + test (Level 1) + behavior comparison against live traces (Level 2)
5. **Switch** — squash merge to `main`, restart; the old commit is the rollback point

**Safety:** the Circuit Breaker / PostSwitchMonitor watches the failure rate after every switch. If it spikes, the system reverts automatically and notifies you.

**Auto-approval:** high-confidence, low-risk mutations can be approved automatically via the Approval Gate (configurable risk levels + timeout). Anything riskier waits for a human.

**Slot model:** no file copying, no symlinks. `main` = live runtime. `evolution/xxx` = work-in-progress. Switching is just a git merge + process restart, managed by the SlotManager.

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

### Memory tools & auto-persistence

GeminiClaw doesn't just store memory — it actively writes and searches it:

- **Auto-persistence** — `MemoryWriter` persists every conversation turn into per-day `daily/` files automatically, so nothing is lost between sessions.
- **`memory_search`** — full-text search across **all** memory sources at once: daily logs, per-agent private memory, public knowledge, and raw chat history.
- **`memory_edit` / `memory_inspect`** — inspect the whole memory overview and edit specific layers, with a fixed-layer guard so structural layers can't be corrupted.
- **Per-agent private memory** — `WorkingMemoryBuilder` assembles the four memory layers plus each agent's private memory into the working context.
- **`/mem` command** — a `/mem` slash command and natural-language triggers route to an isolated Memory Manager session for direct memory operations.

---

## Multi-Agent & Agent Gate

GeminiClaw runs a real multi-agent system rather than ad-hoc subagents.

- **Per-user agents** — each user has their own set of agents; `list_agents` / `switch_agent` / `create_agent` tools let the runtime (and the user) move between them.
- **Agent Gate** — guards the busy state. When the selected agent is mid-task, an inline keyboard offers **queue / interrupt / new agent** instead of dropping the message.
- **Agent selection** — the "select agent" keyboard lists **all** active agents (including busy ones), each annotated with a recent-topic summary so same-named agents are distinguishable, plus a 🟢/🔴 busy marker. Lists longer than 8 paginate. Picking a busy agent opens the queue/interrupt choice.
- **Interruptible tasks** — every task runs under an `AbortController`; interrupting flushes memory first so context is preserved for the next turn.
- **Session inspection** — `list_sessions` / `read_session` let an agent recover from a truncated run by reading its own history and resuming from the breakpoint.

---

## Multimodal

A full image pipeline runs end-to-end: **channel ingress → Agent Loop → Provider adapter**.

- Incoming images (e.g. from QQ Bot) are extracted and built into a `ContentPart[]` user message, downloaded with the proper auth token and converted to base64.
- The `view_image` tool fetches and analyzes an image URL on demand; `browser` screenshots return a full base64 PNG.
- The Anthropic adapter supports image blocks in both user messages and `tool_result`.

---

## Multi-Model Routing

<p align="center">
  <img src="https://github.com/user-attachments/assets/5b8f7ea7-a391-4771-995a-3b4b763ba112" alt="Multi-Model Routing" width="600" />
</p>

Configure multiple providers. GeminiClaw routes with ordered fallback — if the primary fails, it tries the next automatically. When a non-primary model answers, the reply is annotated with a `[fallback:route]` footnote.

```yaml
routing:
  default: "mcli/claude-opus-4-6"
  fallback:
    - "mcli/claude-sonnet-4-6"
    - "friday/gemini-3-flash-preview"
```

Supported providers:
- **mcli** — Meituan internal LLM gateway (Anthropic-compatible, custom headers)
- **Friday** — Meituan AIGC platform (OpenAI-compatible, SSE streaming)
- **Anthropic** — Direct Claude API (with prompt caching)
- *Any OpenAI-compatible endpoint via config*

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

# 4. Run
pnpm dev
```

---

## API

```
POST /v1/chat/completions        — Chat (OpenAI-compatible, non-streaming or SSE streaming)
GET  /v1/models                  — List available models
GET  /v1/health                  — Health check + evolution observability

# Sessions & messages
GET  /v1/sessions                — List sessions
GET  /v1/sessions/:id            — Session detail
GET  /v1/sessions/:id/messages   — Session messages

# Multi-agent
GET  /v1/agents                  — List agents
GET  /v1/agents/:id              — Agent detail
GET  /v1/agents/:id/tasks        — Agent tasks
POST /v1/agents/:id/tasks        — Dispatch a task to an agent
POST /v1/sessions/:id/agents     — Create an agent in a session

# Evolution
GET  /v1/evolution/status        — Evolution engine state
POST /v1/evolution/run           — Trigger one evolution cycle manually
POST /v1/evolution/intents       — Add a user intent
GET  /v1/evolution/candidates    — Peek at the intent queue
GET  /v1/evolution/approvals     — List pending approvals
POST /v1/evolution/approvals/:id/approve — Approve an intent
POST /v1/evolution/approvals/:id/reject  — Reject an intent

# Trace
GET  /v1/trace/live              — Live conversation trace (SSE)
```

### Chat

```json
// Request
{
  "model": "mcli/claude-sonnet-4-6",
  "messages": [{ "role": "user", "content": "Hello!" }],
  "stream": false
}
```

Streaming: set `"stream": true` → `text/event-stream`.

---

## Configuration

```yaml
server:
  port: 18790
  host: "0.0.0.0"
  authToken: "your-secret-token"

providers:
  - name: mcli
    type: mcli
    apiKey: "your-key"
    baseUrl: "https://mcli.sankuai.com"   # no /v1 suffix
    extraHeaders:
      X-Working-Dir: "/your/project"
    models: [claude-opus-4-6, claude-sonnet-4-6]

routing:
  default: "mcli/claude-opus-4-6"
  fallback: ["mcli/claude-sonnet-4-6"]

memory:
  strategy: layered   # buffer (dev) or layered (production)
  dataDir: ".data"

evolution:
  enabled: false      # set true in production with monitoring
  autoApproveRiskLevels: ["low"]
  maxCyclesPerDay: 5
  dryRun: false
```

Full configuration reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md) *(coming soon)*

---

## Current Status

> **Phase: Unified Architecture.** The old evolution engine has been fully removed; Twin-System is the single evolution implementation.

| Feature | Status |
|---------|--------|
| Multi-provider routing (mcli / Friday / Anthropic) | ✅ |
| Ordered fallback + `[fallback:route]` footnote | ✅ |
| Anthropic prompt caching | ✅ |
| Bearer auth | ✅ |
| Non-streaming + SSE streaming | ✅ |
| Buffer memory (sliding window) | ✅ |
| Layered memory (SQLite, 4-layer topics) | ✅ |
| `memory_search` across daily / private / public / chat history | ✅ |
| Auto-persistence (MemoryWriter → daily files) | ✅ |
| `memory_edit` / `memory_inspect` / `/mem` command | ✅ |
| Multi-agent system + Agent Gate (queue / interrupt / new) | ✅ |
| Agent selection: all agents, topic summary, pagination | ✅ |
| Interruptible tasks (AbortController + memory flush) | ✅ |
| Multimodal image pipeline (ingress → loop → provider) | ✅ |
| Twin-System: SlotManager + SafetyGuard + EvolutionPipeline | ✅ |
| Twin-System: Mutator / Validator / Persistence / Aggregator | ✅ |
| Twin-System: PostSwitchMonitor + auto-rollback | ✅ |
| Twin-System: Intent Sources (trace / memory / upstream) | ✅ |
| Twin-System: production enablement (metrics / maxCyclesPerDay / dryRun) | ✅ |
| Twin-System: auto-approval workflow (Approval Gate) | ✅ |
| Async runs + SSE events | ✅ |
| Upstream tracker (cron-driven diff detection) | ✅ |
| 553 unit tests, 0 failures | ✅ |
| Production evolution enabled (`evolution.enabled: true`) | 🔜 |
| Intent source expansion (auto-generate from trace / memory / upstream) | 🔜 |

---

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full Twin-System design, evolution engine internals, and the philosophy behind GeminiClaw.

---

## Licensing

GeminiClaw is licensed under the [Business Source License 1.1](LICENSE).

- **Free** for personal and evaluation use
- **Commercial use** requires a license — contact [pingjiang.li@outlook.com](mailto:pingjiang.li@outlook.com)
- Converts to **Apache 2.0** on 2030-05-05
