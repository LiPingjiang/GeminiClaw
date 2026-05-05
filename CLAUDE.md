# GeminiClaw — Agent Instructions

## What This Is

GeminiClaw is a **standalone agent runtime** with multi-model support, memory system, and a Twin-System evolution engine. It is a clean-room implementation — zero dependency on OpenClaw source code.

Read `docs/ARCHITECTURE.md` for the full design philosophy before touching any code.

## Current Status

**Phase: Functional.** 核心功能已实现并通过测试（78 个测试全绿）。

已完成：
- config 加载与校验（Zod schema）
- providers：Anthropic、mcli（支持 extraHeaders）、Friday（含 SSE stream）
- ProviderRouter：主路由 + 有序 fallback
- memory：buffer 策略（滑动窗口）+ layered 策略（SQLite 分层 topics）
- server：Fastify 5，`/v1/agent/chat`（非流式 + SSE 流式）、`/v1/health`、Bearer 认证
- 输入校验：空消息 → 400

待实现：
- Twin-System slot-a/slot-b 目录结构
- evolution/ 进化引擎
- `/v1/runs/:id/events` 异步 run 接口

## Stack

- TypeScript + Node.js (ESM)
- Fastify (HTTP server)
- Vitest (tests)
- pnpm (package manager)
- BSL 1.1 license

## Directory Layout (target)

```
src/
├── index.ts              ← entry point
├── server/               ← Fastify HTTP server + routes
├── providers/            ← LLM provider adapters (Anthropic, OpenAI, mcli, Friday...)
├── memory/               ← session + long-term memory
├── evolution/            ← Twin-System evolution engine
└── config/               ← config loader (reads config.yaml, never hardcodes secrets)
```

## Key Constraints

- **No OpenClaw imports.** Ever. Not even types.
- **Config from config.yaml only.** No hardcoded API keys, tokens, or model names.
- **config.yaml is gitignored.** Use config.example.yaml as the template.
- **BSL 1.1.** Do not add dependencies with GPL or AGPL licenses.

## API Surface (target)

```
POST /v1/agent/chat          — send message, returns response (or run_id for async)
GET  /v1/runs/:id/events     — SSE stream for async runs
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

## Build & Run

```bash
pnpm install
pnpm dev          # tsx watch
pnpm build        # tsc
pnpm test         # vitest
```

## What To Build Next

1. Twin-System 目录结构（slot-a / slot-b / active 软链接）
2. evolution/ 进化引擎（intent → mutator → validator → switcher）
3. `/v1/runs/:id/events` 异步 run 接口
4. 上游 OpenClaw diff 追踪 cron job

## Build & Test

```bash
pnpm install
pnpm dev          # tsx watch
pnpm build        # tsc
pnpm test         # vitest（78 tests，全绿）
```
