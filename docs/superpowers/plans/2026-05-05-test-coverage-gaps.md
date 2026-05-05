# GeminiClaw 测试覆盖缺口补充计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补全 GeminiClaw 现有测试的覆盖缺口，包括：friday stream、mcli headers、输入校验、layered 策略核心路径、provider fallback、以及 E2E 脚本扩展。

**Architecture:** 纯测试补充，不改业务代码。vitest 单元测试 + bash E2E 脚本扩展。

**Tech Stack:** vitest, TypeScript ESM, bash, curl

**当前状态：** 52 tests passing，需补充到 ~90 tests。

---

## Task 1: friday stream 方法测试

**Files:**
- Modify: `src/providers/friday.test.ts`

- [ ] **Step 1: 在 friday.test.ts 末尾追加 stream 测试**

在 `src/providers/friday.test.ts` 末尾追加以下测试（不删除现有测试）：

```typescript
// ── stream 测试 ──────────────────────────────────────────────

it("stream yields delta chunks from SSE", async () => {
  // 模拟 SSE 响应体
  const sseBody = [
    `data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":" world"}}]}\n\n`,
    `data: [DONE]\n\n`,
  ].join("")

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseBody))
      controller.close()
    },
  })

  fetchMock.mockResolvedValue({
    ok: true,
    body: readable,
  })

  const { FridayProvider } = await import("./friday.js")
  const p = new FridayProvider(makeConfig())

  const chunks: string[] = []
  for await (const chunk of p.stream([{ role: "user", content: "hi" }])) {
    if (chunk.delta) chunks.push(chunk.delta)
    if (chunk.done) break
  }

  expect(chunks).toEqual(["Hello", " world"])
})

it("stream throws on non-ok response", async () => {
  fetchMock.mockResolvedValue({
    ok: false,
    status: 503,
    text: async () => "service unavailable",
  })

  const { FridayProvider } = await import("./friday.js")
  const p = new FridayProvider(makeConfig())

  await expect(async () => {
    for await (const _ of p.stream([{ role: "user", content: "hi" }])) { /* drain */ }
  }).rejects.toThrow("friday API error 503")
})

it("stream skips malformed SSE lines", async () => {
  const sseBody = [
    `data: not-json\n\n`,
    `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`,
    `data: [DONE]\n\n`,
  ].join("")

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseBody))
      controller.close()
    },
  })

  fetchMock.mockResolvedValue({ ok: true, body: readable })

  const { FridayProvider } = await import("./friday.js")
  const p = new FridayProvider(makeConfig())

  const chunks: string[] = []
  for await (const chunk of p.stream([{ role: "user", content: "hi" }])) {
    if (chunk.delta) chunks.push(chunk.delta)
    if (chunk.done) break
  }

  expect(chunks).toEqual(["ok"])
})
```

- [ ] **Step 2: 运行测试确认通过**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/providers/friday.test.ts 2>&1 | tail -10
```
Expected: 6 tests PASS（原 3 + 新 3）

- [ ] **Step 3: 全量测试**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -5
```
Expected: all pass

- [ ] **Step 4: commit**

```bash
cd ~/Codes/GeminiClaw && git add src/providers/friday.test.ts
git commit -m "test: add friday stream coverage (SSE chunks, errors, malformed)"
```

---

## Task 2: mcli headers + router stream 测试

**Files:**
- Modify: `src/providers/router.test.ts`（追加 stream 测试）
- Create: `src/providers/mcli.test.ts`（新建，补充 headers 测试）

- [ ] **Step 1: 新建 src/providers/mcli.test.ts**

```typescript
// src/providers/mcli.test.ts
import { it, expect, vi, beforeEach } from "vitest"
import Anthropic from "@anthropic-ai/sdk"

vi.mock("@anthropic-ai/sdk")

function makeConfig(headers?: Record<string, string>) {
  return {
    name: "mcli",
    type: "mcli" as const,
    apiKey: "test-key",
    baseUrl: "https://mcli.example.com",
    models: ["claude-opus-4-6"],
    headers,
  }
}

beforeEach(() => {
  vi.mocked(Anthropic).mockClear()
})

it("passes defaultHeaders to Anthropic client when headers configured", async () => {
  const { McliProvider } = await import("./mcli.js")
  new McliProvider(makeConfig({ "X-Working-Dir": "/home/user" }))

  expect(vi.mocked(Anthropic)).toHaveBeenCalledWith(
    expect.objectContaining({
      defaultHeaders: { "X-Working-Dir": "/home/user" },
    }),
  )
})

it("passes empty defaultHeaders when no headers configured", async () => {
  const { McliProvider } = await import("./mcli.js")
  new McliProvider(makeConfig())

  expect(vi.mocked(Anthropic)).toHaveBeenCalledWith(
    expect.objectContaining({
      defaultHeaders: {},
    }),
  )
})

it("uses apiKey from config", async () => {
  const { McliProvider } = await import("./mcli.js")
  new McliProvider(makeConfig())

  expect(vi.mocked(Anthropic)).toHaveBeenCalledWith(
    expect.objectContaining({ apiKey: "test-key" }),
  )
})

it("falls back to 'mcli' when no apiKey", async () => {
  const { McliProvider } = await import("./mcli.js")
  new McliProvider({ ...makeConfig(), apiKey: undefined })

  expect(vi.mocked(Anthropic)).toHaveBeenCalledWith(
    expect.objectContaining({ apiKey: "mcli" }),
  )
})
```

- [ ] **Step 2: 运行测试确认通过**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/providers/mcli.test.ts 2>&1 | tail -10
```
Expected: 4 tests PASS

- [ ] **Step 3: 在 router.test.ts 末尾追加 stream 测试**

在 `src/providers/router.test.ts` 末尾追加：

```typescript
// ── stream 测试 ──────────────────────────────────────────────

it("stream() delegates to default provider", async () => {
  const chunks = [
    { delta: "hello", done: false },
    { delta: " world", done: false },
    { delta: "", done: true },
  ]

  async function* mockStream() {
    for (const c of chunks) yield c
  }

  const provider = {
    name: "p1",
    chat: vi.fn(),
    stream: vi.fn().mockReturnValue(mockStream()),
  } as unknown as Provider

  const router = new ProviderRouter([provider], { default: "p1/m1", fallback: [] })

  const received: StreamChunk[] = []
  for await (const chunk of router.stream([{ role: "user", content: "hi" }])) {
    received.push(chunk)
  }

  expect(received).toHaveLength(3)
  expect(received[0].delta).toBe("hello")
  expect(received[2].done).toBe(true)
  expect(provider.stream).toHaveBeenCalledWith(
    [{ role: "user", content: "hi" }],
    expect.objectContaining({ model: "m1" }),
  )
})

it("stream() throws when provider not found", async () => {
  const router = new ProviderRouter([], { default: "missing/m1", fallback: [] })

  await expect(async () => {
    for await (const _ of router.stream([{ role: "user", content: "hi" }])) { /* drain */ }
  }).rejects.toThrow('Provider "missing" not found')
})
```

需要在 router.test.ts 顶部 import 中补上 `StreamChunk`：
找到现有的 import 行：
```typescript
import type { Provider, Message, ChatOptions, ChatResponse } from "./types.js"
```
改为：
```typescript
import type { Provider, Message, ChatOptions, ChatResponse, StreamChunk } from "./types.js"
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/providers/router.test.ts 2>&1 | tail -10
```
Expected: 6 tests PASS（原 4 + 新 2）

- [ ] **Step 5: 全量测试**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -5
```
Expected: all pass

- [ ] **Step 6: commit**

```bash
cd ~/Codes/GeminiClaw && git add src/providers/mcli.test.ts src/providers/router.test.ts
git commit -m "test: add mcli headers coverage + router stream coverage"
```

---

## Task 3: chat route 补充测试（输入校验 + stream + appendTurn）

**Files:**
- Modify: `src/server/routes/chat.test.ts`

- [ ] **Step 1: 在 chat.test.ts 末尾追加测试**

在 `src/server/routes/chat.test.ts` 末尾追加（保留现有 5 个测试）：

```typescript
// ── 输入校验 ──────────────────────────────────────────────────

it("returns 400 when message is empty string", async () => {
  const app = await buildServer(makeConfig(), makeRouter(), makeStrategy())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "" },
  })
  expect(res.statusCode).toBe(400)
  const body = JSON.parse(res.body)
  expect(body.error).toMatch(/message/)
})

it("returns 400 when message is missing", async () => {
  const app = await buildServer(makeConfig(), makeRouter(), makeStrategy())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: {},
  })
  expect(res.statusCode).toBe(400)
})

it("returns 400 when message is whitespace only", async () => {
  const app = await buildServer(makeConfig(), makeRouter(), makeStrategy())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "   " },
  })
  expect(res.statusCode).toBe(400)
})

// ── appendTurn 被调用 ─────────────────────────────────────────

it("calls appendTurn after successful chat", async () => {
  const strategy = makeStrategy()
  const app = await buildServer(makeConfig(), makeRouter(), strategy)
  await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "hello", sessionId: "s1" },
  })
  expect(strategy.appendTurn).toHaveBeenCalledWith(
    "s1",
    { role: "user", content: "hello" },
    { role: "assistant", content: "pong" },
  )
})

it("calls getContext with the user message", async () => {
  const strategy = makeStrategy()
  const app = await buildServer(makeConfig(), makeRouter(), strategy)
  await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "test message", sessionId: "s99" },
  })
  expect(strategy.getContext).toHaveBeenCalledWith("s99", "test message")
})

// ── sessionId 自动生成 ────────────────────────────────────────

it("generates sessionId when not provided", async () => {
  const app = await buildServer(makeConfig(), makeRouter(), makeStrategy())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "hi" },
  })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body)
  expect(body.sessionId).toBeDefined()
  expect(typeof body.sessionId).toBe("string")
  expect(body.sessionId.length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: 运行测试确认通过**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/server/routes/chat.test.ts 2>&1 | tail -10
```
Expected: 11 tests PASS（原 5 + 新 6）

- [ ] **Step 3: 全量测试**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -5
```
Expected: all pass

- [ ] **Step 4: commit**

```bash
cd ~/Codes/GeminiClaw && git add src/server/routes/chat.test.ts
git commit -m "test: add chat route coverage (validation, appendTurn, getContext, sessionId)"
```

---

## Task 4: layered 策略核心路径补充测试

**Files:**
- Modify: `src/memory/strategies/layered.test.ts`

- [ ] **Step 1: 在 layered.test.ts 末尾追加测试**

追加以下测试（保留现有 2 个）：

```typescript
it("getContext loads topic doc when router matches with high confidence", async () => {
  const { LayeredStrategy } = await import("./layered.js")
  const db = makeDb()

  // 插入一个活跃事项
  db.prepare(`
    INSERT INTO memory_topics (id, title, summary, doc_level2, active)
    VALUES (?, ?, ?, ?, 1)
  `).run("t1", "GeminiClaw 开发", "构建记忆系统", "详细概览内容")

  // router 返回高置信度匹配
  const routerResponse = JSON.stringify({
    matches: [{ topicId: "t1", confidence: 0.9, level: 2 }],
    confidence: 0.9,
  })
  const routerProvider = makeProvider(routerResponse)

  const strategy = new LayeredStrategy({
    db,
    routerProvider,
    triageProvider: routerProvider,
    systemPrompt: "You are helpful.",
    recentMessageLimit: 20,
    triageAfterTurns: 3,
    compactThresholdBytes: 6144,
    maxActiveTopics: 16,
  })

  await strategy.ensureSession("s1")
  const ctx = await strategy.getContext("s1", "记忆系统进展")

  // system message 应包含事项索引
  const systemMsg = ctx.messages.find(m => m.role === "system")
  expect(systemMsg?.content).toContain("GeminiClaw 开发")

  // 应有包含文档内容的 system message
  const docMsg = ctx.messages.filter(m => m.role === "system")
  expect(docMsg.some(m => m.content.includes("详细概览内容"))).toBe(true)
})

it("getContext skips doc loading when router returns low confidence", async () => {
  const { LayeredStrategy } = await import("./layered.js")
  const db = makeDb()

  db.prepare(`
    INSERT INTO memory_topics (id, title, summary, doc_level2, active)
    VALUES (?, ?, ?, ?, 1)
  `).run("t1", "某事项", "摘要", "详细内容")

  // 低置信度
  const routerResponse = JSON.stringify({
    matches: [{ topicId: "t1", confidence: 0.3, level: 2 }],
    confidence: 0.3,
  })
  const routerProvider = makeProvider(routerResponse)

  const strategy = new LayeredStrategy({
    db,
    routerProvider,
    triageProvider: routerProvider,
    systemPrompt: "You are helpful.",
    recentMessageLimit: 20,
    triageAfterTurns: 3,
    compactThresholdBytes: 6144,
    maxActiveTopics: 16,
  })

  await strategy.ensureSession("s1")
  const ctx = await strategy.getContext("s1", "随便问问")

  // 低置信度（<0.5）不加载文档
  const docMsgs = ctx.messages.filter(m => m.role === "system" && m.content.includes("详细内容"))
  expect(docMsgs).toHaveLength(0)
})

it("appendTurn creates new topic when triage returns new_topic after threshold", async () => {
  const { LayeredStrategy } = await import("./layered.js")
  const db = makeDb()

  const triageResponse = JSON.stringify({
    action: "new_topic",
    title: "GeminiClaw 记忆系统",
    summary: "讨论了分层记忆架构",
  })
  const provider = makeProvider(triageResponse)

  const strategy = new LayeredStrategy({
    db,
    routerProvider: makeProvider(JSON.stringify({ matches: [], confidence: 0 })),
    triageProvider: provider,
    systemPrompt: "You are helpful.",
    recentMessageLimit: 20,
    triageAfterTurns: 2,  // 2轮触发
    compactThresholdBytes: 6144,
    maxActiveTopics: 16,
  })

  await strategy.ensureSession("s1")

  // 第一轮
  await strategy.appendTurn(
    "s1",
    { role: "user", content: "我们来讨论记忆系统" },
    { role: "assistant", content: "好的，记忆系统设计..." },
  )
  // 第二轮触发立项
  await strategy.appendTurn(
    "s1",
    { role: "user", content: "分层策略怎么实现" },
    { role: "assistant", content: "分层策略使用 SQLite..." },
  )

  // 等待异步后台任务
  await new Promise(r => setTimeout(r, 100))

  const topics = db.prepare(`SELECT * FROM memory_topics WHERE active = 1`).all() as Array<{ title: string }>
  expect(topics.some(t => t.title === "GeminiClaw 记忆系统")).toBe(true)
})

it("appendTurn persists messages and updates session count", async () => {
  const { LayeredStrategy } = await import("./layered.js")
  const db = makeDb()
  const provider = makeProvider(JSON.stringify({ action: "skip" }))

  const strategy = new LayeredStrategy({
    db,
    routerProvider: makeProvider(JSON.stringify({ matches: [], confidence: 0 })),
    triageProvider: provider,
    systemPrompt: "",
    recentMessageLimit: 20,
    triageAfterTurns: 5,
    compactThresholdBytes: 6144,
    maxActiveTopics: 16,
  })

  await strategy.ensureSession("s1")
  await strategy.appendTurn(
    "s1",
    { role: "user", content: "msg1" },
    { role: "assistant", content: "reply1" },
  )
  await strategy.appendTurn(
    "s1",
    { role: "user", content: "msg2" },
    { role: "assistant", content: "reply2" },
  )

  const msgs = db.prepare(`SELECT * FROM chat_messages WHERE session_id = 's1'`).all()
  expect(msgs).toHaveLength(4)

  const session = db.prepare(`SELECT message_count FROM chat_sessions WHERE id = 's1'`).get() as { message_count: number }
  expect(session.message_count).toBe(4)
})

it("getContext trims history to recentMessageLimit", async () => {
  const { LayeredStrategy } = await import("./layered.js")
  const db = makeDb()
  const provider = makeProvider(JSON.stringify({ action: "skip" }))

  const strategy = new LayeredStrategy({
    db,
    routerProvider: makeProvider(JSON.stringify({ matches: [], confidence: 0 })),
    triageProvider: provider,
    systemPrompt: "sys",
    recentMessageLimit: 4,  // 只保留最近 4 条
    triageAfterTurns: 99,
    compactThresholdBytes: 6144,
    maxActiveTopics: 16,
  })

  await strategy.ensureSession("s1")

  // 写入 6 轮（12 条消息）
  for (let i = 0; i < 6; i++) {
    await strategy.appendTurn(
      "s1",
      { role: "user", content: `user msg ${i}` },
      { role: "assistant", content: `reply ${i}` },
    )
  }

  const ctx = await strategy.getContext("s1", "next")
  const nonSystem = ctx.messages.filter(m => m.role !== "system")
  expect(nonSystem).toHaveLength(4)
  // 最后 4 条：user5, reply5 被截断到 4 条
  expect(nonSystem[nonSystem.length - 1].content).toBe("reply 5")
})
```

- [ ] **Step 2: 运行测试确认通过**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/memory/strategies/layered.test.ts 2>&1 | tail -15
```
Expected: 7 tests PASS（原 2 + 新 5）

- [ ] **Step 3: 全量测试**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -5
```
Expected: all pass

- [ ] **Step 4: commit**

```bash
cd ~/Codes/GeminiClaw && git add src/memory/strategies/layered.test.ts
git commit -m "test: add layered strategy coverage (routing, triage, persist, trim)"
```

---

## Task 5: background + triage + buffer 边界测试补充

**Files:**
- Modify: `src/memory/background.test.ts`
- Modify: `src/memory/triage.test.ts`
- Modify: `src/memory/strategies/buffer.test.ts`

- [ ] **Step 1: background.test.ts 追加 runAsync 异常隔离测试**

在 `src/memory/background.test.ts` 末尾追加：

```typescript
it("runAsync does not throw even when summarize fails", async () => {
  const failingProvider: Provider = {
    name: "friday",
    chat: vi.fn().mockRejectedValue(new Error("network error")),
    stream: vi.fn(),
  } as unknown as Provider

  const db = makeDb()
  const { BackgroundService } = await import("./background.js")
  const svc = new BackgroundService(failingProvider, db, {
    compactThresholdBytes: 6144,
    maxActiveTopics: 16,
  })

  // runAsync 不应抛出，应静默吞掉错误
  expect(() => {
    svc.runAsync(null, { role: "user", content: "hi" }, { role: "assistant", content: "hello" })
  }).not.toThrow()

  // 等待 fire-and-forget 完成
  await new Promise(r => setTimeout(r, 50))
  // 没有崩溃即为通过
})

it("appendToTopic does nothing for non-existent topic", async () => {
  const db = makeDb()
  const { BackgroundService } = await import("./background.js")
  const svc = new BackgroundService(makeProvider("摘要"), db, {
    compactThresholdBytes: 6144,
    maxActiveTopics: 16,
  })

  // 不应抛出
  await expect(svc.appendToTopic("non-existent-id", "content")).resolves.toBeUndefined()
})
```

- [ ] **Step 2: triage.test.ts 追加边界测试（恰好等于 threshold）**

在 `src/memory/triage.test.ts` 末尾追加：

```typescript
it("triggers triage when turns exactly equal threshold", async () => {
  const { TriageService } = await import("./triage.js")
  const responseJson = JSON.stringify({ action: "skip" })
  const provider = makeProvider(responseJson)
  const svc = new TriageService(provider, { triageAfterTurns: 3 })

  // 恰好 3 条 user 消息 = threshold
  const msgs = [
    { role: "user" as const, content: "msg1" },
    { role: "assistant" as const, content: "reply1" },
    { role: "user" as const, content: "msg2" },
    { role: "assistant" as const, content: "reply2" },
    { role: "user" as const, content: "msg3" },
    { role: "assistant" as const, content: "reply3" },
  ]
  const result = await svc.triage("s1", msgs, [])
  // 应该触发（调用了 provider），结果是 skip
  expect(result.action).toBe("skip")
  expect(provider.chat).toHaveBeenCalledOnce()
})

it("does NOT trigger triage when turns one below threshold", async () => {
  const { TriageService } = await import("./triage.js")
  const provider = makeProvider("{}")
  const svc = new TriageService(provider, { triageAfterTurns: 3 })

  // 只有 2 条 user 消息 < threshold
  const msgs = [
    { role: "user" as const, content: "msg1" },
    { role: "assistant" as const, content: "reply1" },
    { role: "user" as const, content: "msg2" },
    { role: "assistant" as const, content: "reply2" },
  ]
  const result = await svc.triage("s1", msgs, [])
  expect(result.action).toBe("skip")
  // 不应调用 provider（直接 skip，不耗 token）
  expect(provider.chat).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: buffer.test.ts 追加边界测试**

在 `src/memory/strategies/buffer.test.ts` 末尾追加：

```typescript
it("handles limit=1 (only last message kept)", async () => {
  const strategy = new BufferStrategy({ recentMessageLimit: 1 })
  await strategy.appendTurn(
    "s1",
    { role: "user", content: "first" },
    { role: "assistant", content: "first reply" },
  )
  await strategy.appendTurn(
    "s1",
    { role: "user", content: "second" },
    { role: "assistant", content: "second reply" },
  )
  const ctx = await strategy.getContext("s1", "next")
  expect(ctx.messages).toHaveLength(1)
  expect(ctx.messages[0].content).toBe("second reply")
})

it("multiple sessions are isolated", async () => {
  const strategy = new BufferStrategy({ recentMessageLimit: 20 })
  await strategy.appendTurn(
    "sA",
    { role: "user", content: "session A" },
    { role: "assistant", content: "reply A" },
  )
  await strategy.appendTurn(
    "sB",
    { role: "user", content: "session B" },
    { role: "assistant", content: "reply B" },
  )
  const ctxA = await strategy.getContext("sA", "next")
  const ctxB = await strategy.getContext("sB", "next")

  expect(ctxA.messages.some(m => m.content.includes("session B"))).toBe(false)
  expect(ctxB.messages.some(m => m.content.includes("session A"))).toBe(false)
})
```

- [ ] **Step 4: 运行所有修改的测试**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/memory/background.test.ts src/memory/triage.test.ts src/memory/strategies/buffer.test.ts 2>&1 | tail -15
```
Expected: background 5 PASS, triage 6 PASS, buffer 6 PASS

- [ ] **Step 5: 全量测试**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -5
```
Expected: all pass

- [ ] **Step 6: commit**

```bash
cd ~/Codes/GeminiClaw && git add src/memory/background.test.ts src/memory/triage.test.ts src/memory/strategies/buffer.test.ts
git commit -m "test: add background/triage/buffer edge case coverage"
```

---

## Task 6: E2E 脚本扩展（provider fallback + layered 策略 + 重启持久化）

**Files:**
- Create: `/tmp/geminiclaw-compare-v2.sh`（扩展版对比脚本）

- [ ] **Step 1: 创建扩展 E2E 脚本**

创建 `/tmp/geminiclaw-compare-v2.sh`：

```bash
#!/usr/bin/env bash
# GeminiClaw 扩展 E2E 测试脚本 v2
# 补充：provider fallback、layered 策略、重启持久化、并发验证

NEW="http://127.0.0.1:18889"
NEW_TOKEN="gemeniclaw-local-dev-token-2026"
REPORT="/tmp/geminiclaw-compare-v2-report.md"
PASS=0; FAIL=0; WARN=0

echo "# GeminiClaw 扩展 E2E 测试报告 v2" > $REPORT
echo "**测试时间：** $(date '+%Y-%m-%d %H:%M:%S')" >> $REPORT
echo "" >> $REPORT

log() { echo "$1" | tee -a $REPORT; }

check() {
  local name="$1" status="$2" detail="$3"
  if [ "$status" = "PASS" ]; then
    PASS=$((PASS+1)); log "✅ **$name** — PASS"
  elif [ "$status" = "WARN" ]; then
    WARN=$((WARN+1)); log "⚠️  **$name** — WARN: $detail"
  else
    FAIL=$((FAIL+1)); log "❌ **$name** — FAIL: $detail"
  fi
}

call_new() {
  curl -s -X POST "$NEW/v1/agent/chat" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $NEW_TOKEN" \
    -d "{\"message\":\"$1\",\"sessionId\":\"$2\"}" --max-time 60
}

# ═══════════════════════════════════════════════════════════════
log "## T11: provider fallback（mcli 失败自动切 friday）"
log ""

# 临时把 mcli 路由改为不存在的端口来模拟失败
# 用一个新实例测试 fallback：只配 friday
FALLBACK_CONFIG="/tmp/geminiclaw-fallback-test.yaml"
cat > $FALLBACK_CONFIG << 'YAMLEOF'
server:
  port: 18890
  host: "127.0.0.1"
  authToken: "test-token"
providers:
  - name: bad-mcli
    type: mcli
    apiKey: "bad-key"
    baseUrl: "http://127.0.0.1:19999"
    models:
      - claude-opus-4-6
  - name: friday
    type: friday
    apiKey: "1954745647103004752"
    baseUrl: "https:///v1/openai/native"
    models:
      - gemini-3-flash-preview
routing:
  default: "bad-mcli/claude-opus-4-6"
  fallback:
    - "bad-mcli/claude-opus-4-6"
    - "friday/gemini-3-flash-preview"
memory:
  enabled: true
  dataDir: "/tmp/geminiclaw-fallback"
  maxSessionAge: 86400
  strategy: buffer
  maxActiveTopics: 16
  compactThresholdBytes: 6144
  recentMessageLimit: 20
  triageAfterTurns: 3
agent:
  maxTurns: 20
  timeoutSeconds: 60
YAMLEOF

cd ~/Codes/GeminiClaw && GEMINICLAW_CONFIG=$FALLBACK_CONFIG node dist/index.js &
FALLBACK_PID=$!
sleep 2

FALLBACK_RESP=$(curl -s -X POST "http://127.0.0.1:18890/v1/agent/chat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token" \
  -d '{"message":"你好","sessionId":"fallback-test"}' --max-time 30)

FALLBACK_CONTENT=$(echo "$FALLBACK_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('response',''))" 2>/dev/null)
FALLBACK_MODEL=$(echo "$FALLBACK_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('model',''))" 2>/dev/null)

kill $FALLBACK_PID 2>/dev/null; wait $FALLBACK_PID 2>/dev/null

log "**Fallback 响应：** ${FALLBACK_CONTENT:0:100}"
log "**使用模型：** $FALLBACK_MODEL"
log ""

if [ -n "$FALLBACK_CONTENT" ] && [ ${#FALLBACK_CONTENT} -gt 5 ]; then
  check "T11-1 mcli 失败自动 fallback 到 friday" "PASS" ""
else
  check "T11-1 mcli 失败自动 fallback 到 friday" "FAIL" "无响应: $FALLBACK_RESP"
fi

if echo "$FALLBACK_MODEL" | grep -qi "gemini\|friday"; then
  check "T11-2 fallback 使用了 friday 模型" "PASS" ""
else
  check "T11-2 fallback 使用了 friday 模型" "WARN" "model=$FALLBACK_MODEL"
fi

log ""

# ═══════════════════════════════════════════════════════════════
log "## T12: 输入类型校验（非字符串 message）"
log ""

TYPE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$NEW/v1/agent/chat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $NEW_TOKEN" \
  -d '{"message":12345}' --max-time 10)

log "**message=12345 HTTP 状态：** $TYPE_STATUS"

if [ "$TYPE_STATUS" = "400" ]; then
  check "T12-1 message 为数字 → 400" "PASS" ""
else
  check "T12-1 message 为数字 → 400" "WARN" "HTTP $TYPE_STATUS（接受了非字符串）"
fi

ARRAY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$NEW/v1/agent/chat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $NEW_TOKEN" \
  -d '{"message":["a","b"]}' --max-time 10)

log "**message=[array] HTTP 状态：** $ARRAY_STATUS"

if [ "$ARRAY_STATUS" = "400" ]; then
  check "T12-2 message 为数组 → 400" "PASS" ""
else
  check "T12-2 message 为数组 → 400" "WARN" "HTTP $ARRAY_STATUS"
fi

log ""

# ═══════════════════════════════════════════════════════════════
log "## T13: 多轮对话深度（5轮）"
log ""

SID13="compare-t13-$(date +%s)"

log "**Round 1-5 连续对话测试**"
call_new "我是一名 Java 工程师" "$SID13" > /dev/null
sleep 1
call_new "我在研究 JVM GC 调优" "$SID13" > /dev/null
sleep 1
call_new "我最近遇到了 G1 GC 停顿时间过长的问题" "$SID13" > /dev/null
sleep 1
call_new "我们公司用的是 JDK 11" "$SID13" > /dev/null
sleep 1

R13=$(call_new "根据我之前说的，给我一个针对性的 GC 调优建议" "$SID13")
R13_CONTENT=$(echo "$R13" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('response',''))" 2>/dev/null)
log "**Round 5 响应：** ${R13_CONTENT:0:300}"
log ""

if echo "$R13_CONTENT" | grep -qi "G1\|GC\|JVM\|Java\|停顿\|调优\|heap\|pause"; then
  check "T13-1 5轮对话上下文连贯" "PASS" ""
else
  check "T13-1 5轮对话上下文连贯" "WARN" "响应未体现历史上下文: ${R13_CONTENT:0:100}"
fi

log ""

# ═══════════════════════════════════════════════════════════════
log "## T14: 并发请求内容正确性"
log ""

SID14A="t14a-$(date +%s)"
SID14B="t14b-$(date +%s)"
SID14C="t14c-$(date +%s)"

log "发起 3 个并发请求，验证响应内容各自正确..."

RA=$(call_new "1加1等于几" "$SID14A" &)
RB=$(call_new "天空是什么颜色" "$SID14B" &)
RC=$(call_new "水的化学式是什么" "$SID14C")
wait

CA=$(echo "$RA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('response',''))" 2>/dev/null)
CB=$(echo "$RB" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('response',''))" 2>/dev/null)
CC=$(echo "$RC" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('response',''))" 2>/dev/null)

log "**并发 A（1+1）响应：** ${CA:0:80}"
log "**并发 B（天空颜色）响应：** ${CB:0:80}"
log "**并发 C（水化学式）响应：** ${CC:0:80}"
log ""

if echo "$CA" | grep -qi "2\|两"; then
  check "T14-1 并发 A 内容正确（1+1=2）" "PASS" ""
else
  check "T14-1 并发 A 内容正确（1+1=2）" "WARN" "$CA"
fi

if echo "$CB" | grep -qi "蓝\|blue"; then
  check "T14-2 并发 B 内容正确（天空蓝色）" "PASS" ""
else
  check "T14-2 并发 B 内容正确（天空蓝色）" "WARN" "$CB"
fi

if echo "$CC" | grep -qi "H2O\|h2o"; then
  check "T14-3 并发 C 内容正确（H2O）" "PASS" ""
else
  check "T14-3 并发 C 内容正确（H2O）" "WARN" "$CC"
fi

log ""

# ═══════════════════════════════════════════════════════════════
log "## T15: buffer 策略重启后历史丢失（符合预期）"
log ""

SID15="t15-$(date +%s)"
call_new "我的密码是 hunter2" "$SID15" > /dev/null
sleep 1

# 重启服务
pkill -f "node dist/index.js" 2>/dev/null; sleep 2
cd ~/Codes/GeminiClaw && node dist/index.js &
sleep 3

R15=$(call_new "我刚才说的密码是什么" "$SID15")
R15_CONTENT=$(echo "$R15" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('response',''))" 2>/dev/null)
log "**重启后响应：** ${R15_CONTENT:0:150}"
log ""

if echo "$R15_CONTENT" | grep -qi "hunter2"; then
  check "T15-1 buffer 重启后历史丢失（符合预期）" "FAIL" "重启后仍记住了历史（不应该）"
else
  check "T15-1 buffer 重启后历史丢失（符合预期）" "PASS" ""
fi

log ""

# ═══════════════════════════════════════════════════════════════
log "## T16: SSE 流式内容完整性"
log ""

SID16="t16-$(date +%s)"
STREAM_FULL=$(curl -s -X POST "$NEW/v1/agent/chat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $NEW_TOKEN" \
  -d "{\"message\":\"请数数：一、二、三、四、五\",\"sessionId\":\"$SID16\",\"stream\":true}" \
  --max-time 30)

# 拼接所有 delta
FULL_TEXT=$(echo "$STREAM_FULL" | python3 -c "
import sys, json
text = ''
for line in sys.stdin:
    line = line.strip()
    if not line.startswith('data: '): continue
    raw = line[6:].strip()
    if raw in ('[DONE]', ''): continue
    try:
        d = json.loads(raw)
        if d.get('type') == 'done': continue
        delta = d.get('choices', [{}])[0].get('delta', {}).get('content', '')
        text += delta
    except: pass
print(text[:300])
" 2>/dev/null)

log "**流式拼接全文：** ${FULL_TEXT:0:200}"
log ""

if [ ${#FULL_TEXT} -gt 10 ]; then
  check "T16-1 SSE 流式内容可完整拼接" "PASS" ""
else
  check "T16-1 SSE 流式内容可完整拼接" "FAIL" "拼接内容为空"
fi

if echo "$FULL_TEXT" | grep -qi "一\|二\|三"; then
  check "T16-2 SSE 流式内容语义正确" "PASS" ""
else
  check "T16-2 SSE 流式内容语义正确" "WARN" "$FULL_TEXT"
fi

log ""

# ═══════════════════════════════════════════════════════════════
log "---"
log ""
log "## 汇总"
log ""
TOTAL=$((PASS+FAIL+WARN))
log "| 结果 | 数量 |"
log "|------|------|"
log "| ✅ PASS | $PASS |"
log "| ❌ FAIL | $FAIL |"
log "| ⚠️  WARN | $WARN |"
log "| 总计 | $TOTAL |"
log ""
if [ $FAIL -eq 0 ]; then
  log "**结论：扩展测试全部通过。**"
else
  log "**结论：有 $FAIL 个失败项，需修复。**"
fi
echo ""
echo "报告写入 $REPORT"
```

- [ ] **Step 2: 确认 config/loader.ts 支持 GEMINICLAW_CONFIG 环境变量**

查看 `src/config/loader.ts`，确认 `loadConfig()` 支持从环境变量读取配置路径：

```bash
cat ~/Codes/GeminiClaw/src/config/loader.ts
```

如果不支持，修改 `loadConfig()` 函数签名，使其优先读取 `process.env.GEMINICLAW_CONFIG`：

```typescript
export function loadConfig(configPath?: string): Config {
  const filePath = resolve(
    configPath ?? process.env.GEMINICLAW_CONFIG ?? process.cwd() + "/config.yaml"
  )
  // ... 其余不变
```

重新 build：
```bash
cd ~/Codes/GeminiClaw && pnpm build 2>&1 | tail -5
```

- [ ] **Step 3: 运行扩展 E2E 测试**

```bash
chmod +x /tmp/geminiclaw-compare-v2.sh && bash /tmp/geminiclaw-compare-v2.sh 2>&1
```
Expected: FAIL=0，WARN ≤ 3

- [ ] **Step 4: commit**

```bash
cd ~/Codes/GeminiClaw && git add src/config/loader.ts
git commit -m "feat: support GEMINICLAW_CONFIG env var for config path"
```

---

## Task 7: 最终全量验证

- [ ] **Step 1: 全量单元测试**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1
```
Expected: ≥ 90 tests，all pass，0 fail

- [ ] **Step 2: 构建验证**

```bash
cd ~/Codes/GeminiClaw && rm -rf dist && pnpm build 2>&1 | tail -5
```
Expected: exit 0

- [ ] **Step 3: 运行基础 E2E**

```bash
bash /tmp/geminiclaw-compare.sh 2>&1 | tail -20
```
Expected: 0 FAIL

- [ ] **Step 4: 运行扩展 E2E**

```bash
bash /tmp/geminiclaw-compare-v2.sh 2>&1 | tail -20
```
Expected: 0 FAIL

- [ ] **Step 5: 打 tag**

```bash
cd ~/Codes/GeminiClaw && git tag v0.2.1 -m "test: complete coverage gaps (unit + E2E)"
```
