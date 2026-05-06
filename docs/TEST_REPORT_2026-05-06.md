# GeminiClaw Test Report — 2026-05-06

## Summary

| Item | Result |
|------|--------|
| Test files | 37 passed |
| Total tests | 249 passed, 0 failed |
| TypeScript build | 0 errors |
| Server startup | OK |
| Version | v0.3.0 |

## New Features (this session)

### IntentEngine — Evolution Engine 意图生成（三来源）
- **TraceAnalyzer** (`src/evolution/intent/trace-analyzer.ts`) — trace 失败率分析 → behavior_fix intent
- **MemoryTopicsAnalyzer** (`src/evolution/intent/memory-topics-analyzer.ts`) — memory topics 大小分析 → performance intent
- **UpstreamSyncSource** (`src/evolution/intent/upstream-sync.ts`) — 上游 git diff + LLM 分析 → upstream_sync intent
- **IntentEngine** (`src/evolution/intent/engine.ts`) — 三源聚合、去重、按风险排序、写 DB

### EvolutionEngine 集成
- IntentEngine 注入 EvolutionEngine
- `runOnce()` 队列为空时自动调用 `generateIntents()`
- 新增 HTTP 端点：`POST /v1/evolution/generate-intents`、`POST /v1/evolution/intents`

### 异步 Run 接口
- `RunStore` (`src/server/routes/run-store.ts`) — 内存状态存储
- `GET /v1/runs/:id/events` — SSE 流式订阅异步 run 结果

### QQBot 通道
- `src/channels/qqbot/index.ts` — C2C 消息 webhook，HMAC-SHA256 签名验证
- Config 开关：`channels.qqbot.enabled: true`

## API Surface

```
POST /v1/agent/chat                  — send message (sync + SSE stream)
GET  /v1/runs/:id/events             — SSE stream for async runs  ← NEW
GET  /v1/health                      — health check
GET  /v1/evolution/status            — evolution engine status
POST /v1/evolution/run               — trigger one evolution cycle
POST /v1/evolution/switch            — manual slot switch
POST /v1/evolution/approve/:id       — approve high-risk intent
GET  /v1/evolution/history           — evolution history
POST /v1/evolution/generate-intents  — trigger intent generation  ← NEW
POST /v1/evolution/intents           — add user-triggered intent  ← NEW
POST /webhook/qqbot                  — QQBot webhook (when enabled) ← NEW
```
