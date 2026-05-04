# GeminiClaw — Agent Instructions

## What This Is

GeminiClaw is a **standalone agent runtime** with multi-model support, memory system, and a Twin-System evolution engine. It is a clean-room implementation — zero dependency on OpenClaw source code.

Read `docs/ARCHITECTURE.md` for the full design philosophy before touching any code.

## Current Status

**Phase: Initial build.** src/ is empty. We are building from scratch.

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

## What To Build First

1. `src/config/` — load and validate config.yaml
2. `src/providers/` — at minimum: Anthropic + mcli adapters
3. `src/server/` — Fastify server, `/v1/agent/chat` and `/v1/health`
4. `src/memory/` — in-memory session store (file persistence later)
5. Wire everything in `src/index.ts`
6. Tests for provider adapters and config loading
