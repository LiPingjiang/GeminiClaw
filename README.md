<p align="center">
  <img src="https://github.com/user-attachments/assets/def707b5-a3e5-4c45-870d-78d5b3fbde3d" alt="GeminiClaw" width="600" />
</p>

<h1 align="center">GeminiClaw</h1>

<p align="center">
  <strong>The first self-evolving agent runtime.</strong><br/>
  Twin-System architecture · Layered memory · Multi-model routing · Zero vendor lock-in
</p>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-BSL%201.1-blue" alt="License: BSL 1.1" />
  </a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-green" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/tests-125%20passing-brightgreen" alt="125 tests passing" />
</p>

---

## Why GeminiClaw?

GeminiClaw is a next-generation agent runtime that learns from every conversation and **rewrites its own code** to get better — while always keeping a rollback point.

| | OpenClaw | **GeminiClaw** |
|---|---|---|
| Multi-model routing | ✅ | ✅ |
| Automatic fallback | ⚠️ config-only | ✅ |
| Persistent memory | ✅ file-based | ✅ SQLite, layered |
| Memory hierarchy (topics/summaries) | ❌ | ✅ 4-layer |
| SSE streaming | ✅ | ✅ |
| Self-evolution (rewrite own code) | ❌ | ✅ **Twin-System** |
| Hot-swap without downtime | ❌ | ✅ git branch flow |
| Rollback on regression | ❌ | ✅ circuit breaker |
| Zero vendor lock-in | ⚠️ | ✅ |
| Clean-room TypeScript (ESM, strict) | ❌ | ✅ |

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

---

## Multi-Model Routing

<p align="center">
  <img src="https://github.com/user-attachments/assets/5b8f7ea7-a391-4771-995a-3b4b763ba112" alt="Multi-Model Routing" width="600" />
</p>

Configure multiple providers. GeminiClaw routes with ordered fallback — if the primary fails, it tries the next automatically.

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
- **Anthropic** — Direct Claude API
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
POST /v1/agent/chat          — Chat (non-streaming or SSE streaming)
GET  /v1/health              — Health check

GET  /v1/evolution/status    — Evolution engine state
POST /v1/evolution/run       — Trigger one evolution cycle manually
POST /v1/evolution/switch    — Manually approve and switch
POST /v1/evolution/approve/:id — Approve a high-risk intent
GET  /v1/evolution/history   — View past evolutions
```

### Chat

```json
// Request
{
  "message": "Hello!",
  "sessionId": "optional-session-id",
  "model": "mcli/claude-sonnet-4-6",
  "stream": false
}

// Response
{
  "response": "Hello! How can I help?",
  "sessionId": "abc-123",
  "model": "mcli/claude-sonnet-4-6"
}
```

Streaming: set `"stream": true` → `text/event-stream`, each event: `data: {"delta": "...", "done": false}`

---

## Configuration

```yaml
server:
  port: 18888
  host: "127.0.0.1"
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
```

Full configuration reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md) *(coming soon)*

---

## Roadmap

| Phase | Feature | Status |
|-------|---------|--------|
| A | Types · DB · TraceCollector · Engine skeleton | ✅ Done |
| B | Mutator (LLM loop) · Validator L1 · Switcher | ✅ Done |
| C | Validator L2 (behavior) · CircuitBreaker · Evolution API | 🔄 In progress |
| D | IntentEngine → memory topics · UpstreamSync | 🔜 Next |
| E | CLI · Human review flow · Notifications | 🔜 Planned |

---

## Current Status

| Feature | Status |
|---------|--------|
| Multi-provider routing (mcli / Friday / Anthropic) | ✅ |
| Ordered fallback | ✅ |
| Bearer auth | ✅ |
| Non-streaming + SSE streaming | ✅ |
| Buffer memory (sliding window) | ✅ |
| Layered memory (SQLite, 4-layer topics) | ✅ |
| 125 unit tests, 0 failures | ✅ |
| Evolution Engine: TraceCollector + IntentStore + DB | ✅ |
| Evolution Engine: Mutator (LLM agentic loop, unified diff) | ✅ |
| Evolution Engine: Validator Level 1 (build + test) | ✅ |
| Evolution Engine: Switcher (git branch flow + SIGUSR1) | ✅ |
| Evolution Engine: Validator Level 2 (behavior comparison) | 🔄 |
| Evolution Engine: CircuitBreaker + auto-rollback | 🔄 |
| Evolution HTTP API | 🔄 |
| IntentEngine → memory topics integration | 🔜 |
| UpstreamSync (learn from openclaw / hermes) | 🔜 |

---

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full Twin-System design, evolution engine internals, and the philosophy behind GeminiClaw.

---

## Licensing

GeminiClaw is licensed under the [Business Source License 1.1](LICENSE).

- **Free** for personal and evaluation use
- **Commercial use** requires a license — contact [pingjiang.li@outlook.com](mailto:pingjiang.li@outlook.com)
- Converts to **Apache 2.0** on 2030-05-05
