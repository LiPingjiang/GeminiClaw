# GeminiClaw — Agent Instructions

## What This Is

GeminiClaw is a **standalone agent runtime** with multi-model support, memory system, and a Twin-System evolution engine. It is a clean-room implementation — zero dependency on OpenClaw source code.

Read `docs/ARCHITECTURE.md` for the full design philosophy before touching any code.

## Current Status

**Phase: Unified Architecture.** 旧进化引擎已完全移除，twin-system 是唯一的进化实现。569 个测试全绿。

已完成：
- config 加载与校验（Zod schema + evolution 配置段）
- providers：Anthropic、mcli（支持 extraHeaders）、Friday（含 SSE stream）
- ProviderRouter：主路由 + 有序 fallback
- memory：buffer 策略（滑动窗口）+ layered 策略；分层记忆架构（工作记忆=全局+私人，各分固定区/非固定区；离线记忆=全局长期+per-agent+public_knowledge 公共知识库）；MemoryPaths 解析路径、WorkingMemoryBuilder 组装四层；/mem 记忆管家隔离会话（memory_inspect/memory_edit，固定区改动需 confirm）
- server：Fastify 5，`/v1/agent/chat`（非流式 + SSE 流式）、`/v1/health`、Bearer 认证
- 输入校验：空消息 → 400
- Twin-System：SlotManager、SafetyGuard、EvolutionPipeline
- 进化引擎组件：MutatorImpl、ValidatorImpl、PersistenceAdapter、IntentAggregator、PostSwitchMonitor、SchedulerRunner
- Integration Wiring：factory.ts DI 容器 + 真实适配器 + index.ts 接入 + 优雅关停
- Async Runs：`/v1/runs` + SSE events
- Upstream Tracker：cron-driven diff detection
- E2E smoke test：13 个端到端集成测试
- Old engine cleanup：`src/evolution/` 目录已完全删除，所有消费者已迁移到 twin-system
- Multi-agent 子委派：`delegate_tasks` 工具（OpenClaw 式非阻塞 fire-and-forget）；LifecycleBus 事件总线 + SubagentRegistry 注册表 + AsyncExecutor 后台执行 + ResultInjector 结果推送；父 Agent 不阻塞，子任务完成后自动推送结果给用户
- QQ Bot 空回复修复：ws-client 判空拦截 + signal 透传给工具 + abort 路径不再发送空消息

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
├── multi-agent/          ← sub-agent delegation (Orchestrator + runtime-context + delegate_tasks)
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
pnpm test         # vitest（569 tests，54 files，全绿）
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
9. ~~Auto-approval workflow: ApprovalGate + autoApproveRiskLevels + timeout + API~~ ✅
10. ~~Multi-agent 子委派：delegate_tasks 工具 + runtime-context 单例 + Orchestrator 接入（E2E 实测通过）~~ ✅
11. ~~非阻塞委派改造：OpenClaw 式 fire-and-forget + LifecycleBus + ResultInjector + QQ Bot 空回复修复~~ ✅
