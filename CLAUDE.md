# GeminiClaw — Agent Instructions

## What This Is

GeminiClaw is a **standalone agent runtime** with multi-model support, memory system, and a Twin-System evolution engine. It is a clean-room implementation — zero dependency on OpenClaw source code.

Read `docs/ARCHITECTURE.md` for the full design philosophy before touching any code.

## Current Status

**Phase: Integration Complete.** 全功能实现并集成，441 个测试全绿。

已完成：
- config 加载与校验（Zod schema + evolution 配置段）
- providers：Anthropic、mcli（支持 extraHeaders）、Friday（含 SSE stream）
- ProviderRouter：主路由 + 有序 fallback
- memory：buffer 策略（滑动窗口）+ layered 策略（SQLite 分层 topics）
- server：Fastify 5，`/v1/agent/chat`（非流式 + SSE 流式）、`/v1/health`、Bearer 认证
- 输入校验：空消息 → 400
- Twin-System：SlotManager、SafetyGuard、EvolutionPipeline
- 进化引擎组件：MutatorImpl、ValidatorImpl、PersistenceAdapter、IntentAggregator、PostSwitchMonitor、SchedulerRunner
- Integration Wiring：factory.ts DI 容器 + 真实适配器 + index.ts 接入 + 优雅关停
- Async Runs：`/v1/runs` + SSE events
- Upstream Tracker：cron-driven diff detection
- Knowledge → Evolution Bridge：KnowledgeIntentSource + EvolutionBridge

待实现：
- E2E smoke test（端到端进化循环）
- Old engine cleanup（删除已被取代的旧文件）
- 文档更新（ARCHITECTURE.md 补充 factory 层说明）

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

1. ~~Twin-System 目录结构（slot-a / slot-b / active 软链接）~~ ✅
2. ~~evolution/ 进化引擎（intent → mutator → validator → switcher）~~ ✅
3. ~~`/v1/runs/:id/events` 异步 run 接口~~ ✅
4. ~~上游 OpenClaw diff 追踪 cron job~~ ✅
5. ~~进化引擎统一（MutatorImpl / ValidatorImpl / Persistence / Aggregator / Monitor / Scheduler）~~ ✅

**Next priorities:**
6. Integration wiring: 将各组件组装为完整 runtime（config.yaml → DI container → server startup 一条龙）
7. E2E smoke test: 端到端进化循环（intent → mutate → validate → switch → monitor）
8. Old engine cleanup: 删除 `src/evolution/mutator/mutator.ts` 和 `src/evolution/validator/validator.ts`（已被新 impl 取代）
9. Documentation: 更新 `docs/ARCHITECTURE.md` 反映 twin-system 新架构

## Build & Test

```bash
pnpm install
pnpm dev          # tsx watch
pnpm build        # tsc
pnpm test         # vitest（441 tests，全绿）
```
