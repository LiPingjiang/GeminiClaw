<p align="center">
  <img src="docs/assets/logo.png" alt="GeminiClaw" width="180" />
</p>

<h1 align="center">GeminiClaw</h1>

<p align="center">
  An intelligent agent runtime with multi-model support, memory, and evolution engine.
</p>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-BSL%201.1-blue" alt="License: BSL 1.1" />
  </a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-green" alt="Node >= 20" />
</p>

---

## What is GeminiClaw?

GeminiClaw is a standalone agent runtime that connects to multiple LLM providers (Anthropic, OpenAI, mcli, Friday, and more), with built-in memory management and an evolution engine for continuous improvement.

## Features

- **Multi-model routing** — configure multiple providers with automatic fallback
- **Memory system** — persistent session and long-term memory
- **Evolution engine** — agents that improve over time
- **Clean HTTP API** — simple REST + SSE interface
- **Zero vendor lock-in** — swap providers without changing your code

## Quick Start

```bash
# 1. Clone
git clone https://github.com/LiPingjiang/GeminiClaw.git
cd GeminiClaw

# 2. Install dependencies
npm install

# 3. Configure
cp config.example.yaml config.yaml
# Edit config.yaml with your API keys and preferences

# 4. Run
npm run dev
```

## API

```
POST /v1/agent/chat     — Send a message, get a response (non-streaming or SSE)
GET  /v1/health         — Health check
```

### Chat Request

```json
// Non-streaming
{
  "message": "Hello!",
  "sessionId": "optional-session-id",
  "model": "mcli/claude-sonnet-4-6",
  "stream": false
}

// Streaming (SSE) — add "stream": true
// Response: text/event-stream, each line: data: {"delta": "...", "done": false}
```

### Chat Response

```json
{
  "response": "Hello! How can I help?",
  "sessionId": "abc-123",
  "model": "mcli/claude-sonnet-4-6"
}
```

## Configuration

Copy `config.example.yaml` to `config.yaml` and fill in your values.  
**Never commit `config.yaml`** — it contains your API keys.

> **mcli users:** Set `baseUrl: "https://mcli.sankuai.com"` (no `/v1` suffix). If your deployment requires extra headers (e.g. `X-Working-Dir`), use the `extraHeaders` field.

## Current Status

| Feature | Status |
|---------|--------|
| Multi-provider routing (mcli / Friday / Anthropic) | ✅ Done |
| Automatic fallback | ✅ Done |
| Bearer auth | ✅ Done |
| Non-streaming chat | ✅ Done |
| SSE streaming | ✅ Done |
| Buffer memory (in-process, dev/test) | ✅ Done |
| Layered memory (SQLite, persistent) | ✅ Done |
| Input validation | ✅ Done |
| Twin-System evolution engine | 🔜 Planned |
| `/v1/runs/:id/events` async run API | 🔜 Planned |

## Licensing

GeminiClaw is licensed under the [Business Source License 1.1](LICENSE).

- **Free for personal and evaluation use**
- **Commercial use requires a license** — contact [pingjiang.li@outlook.com](mailto:pingjiang.li@outlook.com)
- **OEM licensing available** — embed GeminiClaw in your product or service
- On **2030-05-05**, this project converts to Apache License 2.0

For commercial and OEM licensing inquiries: **pingjiang.li@outlook.com**
