# GeminiClaw — Agent Instructions

## What This Is

GeminiClaw is a **standalone agent runtime** with multi-model support, memory system, and a Twin-System evolution engine. It is a clean-room implementation — zero dependency on OpenClaw source code.

Read `docs/ARCHITECTURE.md` for the full design philosophy before touching any code.

## Current Status

**Phase: Unified Architecture.** 旧进化引擎已完全移除，twin-system 是唯一的进化实现。394 个测试全绿。

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
- E2E smoke test：13 个端到端集成测试
- Old engine cleanup：`src/evolution/` 目录已完全删除，所有消费者已迁移到 twin-system

待实现：
- 生产环境启用进化（`evolution.enabled: true` + 配套监控）
- Intent 源扩展（从 trace/memory/upstream 自动生成意图）

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
├── twin-system/          ← self-evolution engine (factory DI + all components)
└── config/               ← config loader (reads config.yaml, never hardcodes secrets)
```

## Key Constraints

- **No OpenClaw imports.** Ever. Not even types.
- **Config from config.yaml only.** No hardcoded API keys, tokens, or model names.
- **config.yaml is gitignored.** Use config.example.yaml as the template.
- **BSL 1.1.** Do not add dependencies with GPL or AGPL licenses.

## API Surface

```
POST /v1/agent/chat             — send message, returns response
GET  /v1/runs/:id/events        — SSE stream for async runs
GET  /v1/health                 — health check
GET  /v1/evolution/status       — twin-system status
POST /v1/evolution/run          — trigger one evolution cycle
POST /v1/evolution/intents      — add user intent
GET  /v1/evolution/candidates   — peek at intent queue
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
pnpm test         # vitest（418 tests，全绿）
```

## Roadmap

1. ~~Twin-System 核心类型 + SlotManager + SafetyGuard + Pipeline~~ ✅
2. ~~进化引擎组件（Mutator/Validator/Persistence/Aggregator/Monitor/Scheduler）~~ ✅
3. ~~Integration Wiring（factory.ts DI + config schema + startup）~~ ✅
4. ~~E2E smoke test（端到端进化循环）~~ ✅
5. ~~Old engine cleanup（删除 src/evolution/ + 迁移所有消费者）~~ ✅
6. ~~Documentation update（ARCHITECTURE.md twin-system 架构）~~ ✅

7. ~~Intent sources: trace-based / memory-based / upstream-sync 意图生成器~~ ✅
8. ~~Production enablement: EvolutionMetrics + maxCyclesPerDay + dryRun + /v1/health 可观测性~~ ✅

**Next:**
9. Auto-approval workflow: 低风险自动执行，高风险通知等待确认
