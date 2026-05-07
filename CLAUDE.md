# GeminiClaw — Agent Instructions

## What This Is

GeminiClaw is a **standalone agent runtime** with multi-model support, memory system, and a Twin-System evolution engine. It is a clean-room implementation — zero dependency on OpenClaw source code.

Read `docs/ARCHITECTURE.md` for the full design philosophy before touching any code.

## Current Status

**Phase: Functional.** 核心功能已实现并通过测试（254 个测试全绿）。

### 已完成

- config 加载与校验（Zod schema）
- providers：Anthropic、mcli（含 extraHeaders）、Friday（含 SSE stream）
- ProviderRouter：主路由 + 有序 fallback，工具 schema 格式转换（Anthropic ↔ OpenAI）
- memory：buffer 策略（滑动窗口）+ layered 策略（SQLite 分层 topics）
- server：Fastify 5，Bearer 认证，CORS
- API：`/v1/agent/chat`（非流式 + SSE）、`/v1/agent/resume`、`/v1/agent/status`、`/v1/runs`、`/v1/runs/:id/events`、`/v1/chat/completions`（OpenAI 兼容）、`/v1/health`
- Agent Modes：Auto / Step / Plan / High-confidence（clarify_uncertainty pause/resume）
- 工具调用链路：exec / write / read / edit / web_fetch / clarify_uncertainty
- Twin-System 槽位机制（git branch：main=slot-A，evolution/<id>=slot-B）
- Evolution Engine：IntentEngine、Mutator、Validator（Level 1+2）、Switcher、CircuitBreaker
- 上游 diff 追踪（UpstreamSyncSource，通过 idle loop 自动触发）

### 待实现

- 时机隔离（用户活跃时静默进化，进化确认不污染主对话）
- 部署替换生产 18888 端口

## Stack

- TypeScript + Node.js (ESM)
- Fastify (HTTP server)
- Vitest (tests)
- pnpm (package manager)
- BSL 1.1 license

## Directory Layout

```
src/
├── index.ts              ← entry point
├── server/               ← Fastify HTTP server + routes
├── providers/            ← LLM provider adapters (Anthropic, mcli, Friday...)
├── memory/               ← session + long-term memory
├── evolution/            ← Twin-System evolution engine
├── tools/                ← tool registry (exec, write, read, edit, ...)
└── config/               ← config loader (reads config.yaml, never hardcodes secrets)
```

## Key Constraints

- **No OpenClaw imports.** Ever. Not even types.
- **Config from config.yaml only.** No hardcoded API keys, tokens, or model names.
- **config.yaml is gitignored.** Use config.example.yaml as the template.
- **BSL 1.1.** Do not add dependencies with GPL or AGPL licenses.

## API Surface

```
POST /v1/agent/chat          — send message (stream=true for SSE, mode=auto|step|plan|high-confidence)
POST /v1/agent/resume        — resume a paused loop (pauseId + input)
GET  /v1/agent/status        — check session state (running | paused | idle)
POST /v1/runs                — create async run, returns runId immediately (202)
GET  /v1/runs/:id/events     — SSE stream for async run result
POST /v1/chat/completions    — OpenAI-compatible endpoint (tool use supported)
GET  /v1/health              — health check
```

## Provider Model

Each provider implements a common interface:

```typescript
interface Provider {
  name: string
  chat(messages: Message[], options: ChatOptions): Promise<ChatResponse>
  stream(messages: Message[], options: ChatOptions): AsyncIterable<StreamChunk>
}
```

Providers are loaded from config.yaml. Routing: try primary, fallback in order.

## Build & Test

```bash
pnpm install
pnpm dev          # tsx watch
pnpm build        # tsc
pnpm test         # vitest（254 tests，全绿）
```
