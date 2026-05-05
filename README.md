<p align="center">
  <img src="https://github.com/user-attachments/assets/d72de3a7-c4c6-45b0-93c3-eb214fe8dfaa" alt="GeminiClaw" width="180" />
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
  <img src="https://img.shields.io/badge/tests-78%20passing-brightgreen" alt="78 tests passing" />
</p>

---

## What is GeminiClaw?

GeminiClaw is a next-generation agent runtime built on the shoulders of [OpenClaw](https://github.com/openclaw/openclaw) and [Hermes](https://github.com/hermes-protocol/hermes), taking the best of both and going further.

**OpenClaw** gave us a proven agent execution model and plugin architecture.  
**Hermes** gave us a clean multi-provider routing and message-passing philosophy.  
**GeminiClaw** adds what neither has: **a runtime that rewrites itself**.

---

## Why GeminiClaw?

### The problem with existing agent runtimes

| | OpenClaw | Hermes | **GeminiClaw** |
|---|---|---|---|
| Multi-model routing | ✅ | ✅ | ✅ |
| Automatic fallback | ⚠️ config-only | ✅ | ✅ |
| Persistent memory | ✅ (file-based) | ❌ | ✅ (SQLite, layered) |
| Memory hierarchy (topics/summaries) | ❌ | ❌ | ✅ |
| SSE streaming | ✅ | ✅ | ✅ |
| Self-evolution (rewrite own code) | ❌ | ❌ | ✅ **Twin-System** |
| Hot-swap without downtime | ❌ | ❌ | ✅ slot-a ↔ slot-b |
| Rollback on regression | ❌ | ❌ | ✅ circuit breaker |
| Zero vendor lock-in | ⚠️ | ✅ | ✅ |
| Clean-room TypeScript (ESM, Node 24+) | ❌ | ⚠️ | ✅ |

---

## Core Innovation: Twin-System (Gemini / 双子)

> *"The only runtime that gets better while it runs."*

GeminiClaw is named after the Gemini twins — because it always runs as **two slots**:

```
┌─────────────────┐        ┌─────────────────┐
│   slot-A        │        │   slot-B        │
│   (active)      │◄──────►│   (standby)     │
│   serving live  │        │   being improved│
└────────┬────────┘        └────────┬────────┘
         │                          │
         │   Evolution Engine       │
         │   ┌──────────────────┐   │
         └──►│ 1. Intent        │◄──┘
             │ 2. Mutate (code) │
             │ 3. Validate      │
             │ 4. Swap slots    │
             │ 5. Circuit break │
             └──────────────────┘
```

**The cycle:**
1. **slot-A** serves real traffic, accumulating conversation traces
2. The **Evolution Engine** analyzes traces → generates improvement intents
3. An AI coding agent (Claude via `mc --code`) modifies **slot-B** code
4. slot-B is built, tested, and A/B validated against slot-A
5. On pass: slots swap atomically — slot-B becomes the new active, zero downtime
6. On regression: circuit breaker fires, slot-A stays live, humans are notified

**What this means in practice:**
- The agent learns from every conversation and improves its own code
- You never restart for upgrades — the swap is atomic
- You always have a rollback point (the previous slot)
- The evolution engine itself is protected from self-modification (safety guardrail)

---

## Memory: Layered Topics

Unlike OpenClaw's flat file memory or Hermes's stateless design, GeminiClaw uses a **4-layer topic hierarchy**:

```
Layer 0  Title + one-line summary          (always in context, ~10 tokens)
Layer 1  Condensed summary ~200 tokens     (loaded on relevance)
Layer 2  Section overview ~500 tokens      (loaded on deep relevance)
Layer 3  Full detail ~2K tokens            (loaded on explicit request)
```

- Topics are stored in **SQLite** — persistent across restarts, no cloud dependency
- Automatic **compaction**: when a topic exceeds the threshold, the AI summarizes it down
- **Routing**: a lightweight classifier decides which topics are relevant per message
- **Triage**: new messages are classified — update existing topic, create new one, or ignore

Result: the agent remembers everything important, but only pays attention cost for what's relevant.

---

## Multi-Model Routing

Configure multiple providers. GeminiClaw routes intelligently with ordered fallback:

```yaml
routing:
  default: "mcli/claude-opus-4-6"
  fallback:
    - "mcli/claude-sonnet-4-6"
    - "friday/gemini-3-flash-preview"
```

Supported providers out of the box:
- **mcli** — Meituan internal LLM gateway (Anthropic-compatible, with custom headers)
- **Friday** — Meituan AIGC platform (OpenAI-compatible)
- **Anthropic** — Direct Claude API
- *More via config (OpenAI-compatible endpoints)*

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/LiPingjiang/GeminiClaw.git
cd GeminiClaw

# 2. Install
npm install

# 3. Configure
cp config.example.yaml config.yaml
# Fill in your API keys and provider settings

# 4. Run
npm run dev
```

---

## API

```
POST /v1/agent/chat     — Chat (non-streaming or SSE streaming)
GET  /v1/health         — Health check
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

// Streaming: set "stream": true
// Response: text/event-stream
// Each event: data: {"delta": "...", "done": false}
// Final event: data: {"delta": "", "done": true}
```

---

## Configuration

Copy `config.example.yaml` and fill in your values. **Never commit `config.yaml`** — it contains secrets.

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

---

## Current Status

| Feature | Status |
|---------|--------|
| Multi-provider routing (mcli / Friday / Anthropic) | ✅ Done |
| Ordered fallback | ✅ Done |
| Bearer auth | ✅ Done |
| Non-streaming chat | ✅ Done |
| SSE streaming (Fastify hijack) | ✅ Done |
| Buffer memory (sliding window, dev/test) | ✅ Done |
| Layered memory (SQLite, 4-layer topics) | ✅ Done |
| Input validation | ✅ Done |
| 78 unit tests, 0 failures | ✅ Done |
| Twin-System slot-a/slot-b structure | 🔜 Next |
| Evolution engine (intent → mutate → validate → swap) | 🔜 Next |
| Circuit breaker + auto-rollback | 🔜 Next |
| Upstream OpenClaw diff tracker | 🔜 Next |

---

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full Twin-System design, evolution engine internals, and the philosophy behind GeminiClaw.

---

## Licensing

GeminiClaw is licensed under the [Business Source License 1.1](LICENSE).

- **Free** for personal and evaluation use
- **Commercial use** requires a license — contact [pingjiang.li@outlook.com](mailto:pingjiang.li@outlook.com)
- **OEM licensing** available — embed GeminiClaw in your product
- Converts to **Apache 2.0** on 2030-05-05

For licensing inquiries: **pingjiang.li@outlook.com**
