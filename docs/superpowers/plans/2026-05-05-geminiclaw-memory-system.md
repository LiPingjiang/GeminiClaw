# GeminiClaw Memory System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 GeminiClaw 构建完整的记忆系统：friday provider、session 持久化、分层 topics 记忆策略（含路由、context 组装、后台异步摘要/Compact/清理、立项模块），并保留 buffer 策略供用户选择。

**Architecture:** friday provider 复用 OpenAI-completions 格式（fetch 直调）；session 持久化用 better-sqlite3 写入本地 SQLite；记忆策略通过 `MemoryStrategy` 接口抽象，config.yaml 的 `memory.strategy` 字段选择 `buffer`（滑动窗口）或 `layered`（分层 topics）；layered 策略用 friday/gemini-3-flash-preview 做路由和摘要，claude-opus-4-6 做主对话；chat route 改造为先组装 context 再调用主模型，对话结束后异步触发摘要/立项/清理。

**Tech Stack:** TypeScript ESM, Node.js ≥20, Fastify 5, better-sqlite3, zod, vitest, @anthropic-ai/sdk（已有）

---

## File Map

```
src/
├── config/
│   └── schema.ts                    ← MODIFY: 新增 memory.strategy / memory.maxActiveTopics / memory.compactThresholdBytes
├── providers/
│   ├── friday.ts                    ← CREATE: FridayProvider（OpenAI-completions，fetch）
│   └── friday.test.ts               ← CREATE
├── db/
│   ├── client.ts                    ← CREATE: SQLite 客户端（better-sqlite3 封装）
│   ├── schema.ts                    ← CREATE: 建表 SQL + migrate()
│   └── schema.test.ts               ← CREATE
├── memory/
│   ├── strategy.ts                  ← CREATE: MemoryStrategy 接口 + buildStrategy() 工厂
│   ├── strategies/
│   │   ├── buffer.ts                ← CREATE: BufferStrategy（滑动窗口，纯内存）
│   │   ├── buffer.test.ts           ← CREATE
│   │   ├── layered.ts               ← CREATE: LayeredStrategy（分层 topics，SQLite）
│   │   └── layered.test.ts          ← CREATE
│   ├── router.ts                    ← CREATE: TopicRouter（friday-flash 路由，返回匹配事项+置信度）
│   ├── router.test.ts               ← CREATE
│   ├── context.ts                   ← CREATE: buildContext()（组装 system+索引+文档+近期对话）
│   ├── context.test.ts              ← CREATE
│   ├── background.ts                ← CREATE: runBackground()（摘要→Compact→清理，异步）
│   ├── background.test.ts           ← CREATE
│   ├── triage.ts                    ← CREATE: TriageService（立项判断，3轮门槛）
│   ├── triage.test.ts               ← CREATE
│   └── session.ts                   ← KEEP（buffer 策略的纯内存实现，不删）
├── server/
│   ├── index.ts                     ← MODIFY: buildServer 接收 MemoryStrategy 而非 SessionMemory
│   └── routes/
│       └── chat.ts                  ← MODIFY: 接入 context 组装 + 异步后台
└── index.ts                         ← MODIFY: buildProvider 加 friday；初始化 DB + MemoryStrategy
config.example.yaml                  ← MODIFY: 新增 memory.strategy 示例配置
```

---

## Task 1: friday provider

**Files:**
- Create: `src/providers/friday.ts`
- Create: `src/providers/friday.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/providers/friday.test.ts
import { it, expect, vi, beforeEach, afterEach } from "vitest"

// mock global fetch
const fetchMock = vi.fn()
vi.stubGlobal("fetch", fetchMock)

function makeConfig() {
  return {
    name: "friday",
    type: "friday" as const,
    apiKey: "test-key",
    baseUrl: "https://aigc.example.com/v1/openai/native",
    models: ["gemini-3-flash-preview"],
  }
}

beforeEach(() => { fetchMock.mockReset() })

it("sends correct request and parses response", async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "hello friday" } }],
      model: "gemini-3-flash-preview",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  })

  const { FridayProvider } = await import("./friday.js")
  const p = new FridayProvider(makeConfig())
  const resp = await p.chat([{ role: "user", content: "hi" }])

  expect(resp.content).toBe("hello friday")
  expect(resp.model).toBe("gemini-3-flash-preview")
  expect(fetchMock).toHaveBeenCalledOnce()

  const [url, opts] = fetchMock.mock.calls[0]
  expect(url).toBe("https://aigc.example.com/v1/openai/native/chat/completions")
  const body = JSON.parse(opts.body)
  expect(body.model).toBe("gemini-3-flash-preview")
  expect(body.messages[0].role).toBe("user")
})

it("throws on non-ok response", async () => {
  fetchMock.mockResolvedValue({
    ok: false,
    status: 429,
    text: async () => "rate limited",
  })

  const { FridayProvider } = await import("./friday.js")
  const p = new FridayProvider(makeConfig())
  await expect(p.chat([{ role: "user", content: "hi" }])).rejects.toThrow("friday API error 429")
})

it("uses first model as default", async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "ok" } }],
      model: "gemini-3-flash-preview",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  })

  const { FridayProvider } = await import("./friday.js")
  const p = new FridayProvider(makeConfig())
  await p.chat([{ role: "user", content: "hi" }])
  const body = JSON.parse(fetchMock.mock.calls[0][1].body)
  expect(body.model).toBe("gemini-3-flash-preview")
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/providers/friday.test.ts 2>&1 | tail -10
```
Expected: FAIL — `Cannot find module './friday.js'`

- [ ] **Step 3: 实现 friday provider**

```typescript
// src/providers/friday.ts
import type { ProviderConfig } from "../config/schema.js"
import type { Message, ChatOptions, ChatResponse, StreamChunk, Provider } from "./types.js"

export class FridayProvider implements Provider {
  readonly name: string
  private apiKey: string
  private baseUrl: string
  private defaultModel: string

  constructor(config: ProviderConfig) {
    this.name = config.name
    this.apiKey = config.apiKey ?? ""
    this.baseUrl = (config.baseUrl ?? "").replace(/\/$/, "")
    this.defaultModel = config.models[0]
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const model = options?.model ?? this.defaultModel
    const url = `${this.baseUrl}/chat/completions`

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        max_tokens: options?.maxTokens ?? 4096,
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`friday API error ${res.status}: ${text}`)
    }

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>
      model: string
      usage?: { prompt_tokens: number; completion_tokens: number }
    }

    return {
      content: data.choices[0]?.message?.content ?? "",
      model: data.model,
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
        : undefined,
    }
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    // friday streaming: SSE with data: {...} lines
    const model = options?.model ?? this.defaultModel
    const url = `${this.baseUrl}/chat/completions`

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        max_tokens: options?.maxTokens ?? 4096,
        stream: true,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`friday API error ${res.status}: ${text}`)
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const raw = line.slice(6).trim()
        if (raw === "[DONE]") { yield { delta: "", done: true }; return }
        try {
          const evt = JSON.parse(raw) as { choices?: Array<{ delta?: { content?: string } }> }
          const delta = evt.choices?.[0]?.delta?.content ?? ""
          if (delta) yield { delta, done: false }
        } catch { /* skip malformed */ }
      }
    }
    yield { delta: "", done: true }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/providers/friday.test.ts 2>&1 | tail -10
```
Expected: 3 tests PASS

- [ ] **Step 5: 在 src/index.ts 注册 friday provider**

修改 `src/index.ts`，在 `buildProvider` 中加入 friday case：

```typescript
import { FridayProvider } from "./providers/friday.js"

function buildProvider(config: ProviderConfig): Provider {
  switch (config.type) {
    case "anthropic":
      return new AnthropicProvider(config)
    case "mcli":
      return new McliProvider(config)
    case "friday":
      return new FridayProvider(config)
    default:
      throw new Error(`Unsupported provider type: ${config.type}`)
  }
}
```

- [ ] **Step 6: 全量测试**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -10
```
Expected: all tests pass

- [ ] **Step 7: commit**

```bash
cd ~/Codes/GeminiClaw && git add src/providers/friday.ts src/providers/friday.test.ts src/index.ts
git commit -m "feat: add FridayProvider (OpenAI-completions format)"
```

---

## Task 2: config schema 扩展

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `config.example.yaml`

- [ ] **Step 1: 扩展 memoryConfigSchema**

修改 `src/config/schema.ts`，在 `memoryConfigSchema` 中新增字段：

```typescript
export const memoryStrategySchema = z.enum(["buffer", "layered"]).default("buffer")

export const memoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().default(".data"),
  maxSessionAge: z.number().int().positive().default(86400),
  strategy: memoryStrategySchema,
  maxActiveTopics: z.number().int().min(1).max(50).default(16),
  compactThresholdBytes: z.number().int().positive().default(6144),  // 6KB
  recentMessageLimit: z.number().int().positive().default(20),
  triageAfterTurns: z.number().int().positive().default(3),
})

export type MemoryStrategy = z.infer<typeof memoryStrategySchema>
```

保留其他字段不变，只在 `memoryConfigSchema` 里追加。

- [ ] **Step 2: 运行现有测试确认不破坏**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -10
```
Expected: all pass（新字段有 default，不破坏已有 yaml）

- [ ] **Step 3: 更新 config.example.yaml**

在 `memory:` 段追加：

```yaml
memory:
  enabled: true
  dataDir: ".data"
  maxSessionAge: 86400
  # strategy: buffer    # buffer = 滑动窗口（纯内存，默认）
  # strategy: layered   # layered = 分层 topics（SQLite，完整记忆系统）
  strategy: buffer
  maxActiveTopics: 16
  compactThresholdBytes: 6144   # 6KB，超过触发摘要压缩
  recentMessageLimit: 20
  triageAfterTurns: 3
```

- [ ] **Step 4: commit**

```bash
cd ~/Codes/GeminiClaw && git add src/config/schema.ts config.example.yaml
git commit -m "feat: extend memory config schema (strategy, topics, compact)"
```

---

## Task 3: SQLite 数据库层

**Files:**
- Create: `src/db/client.ts`
- Create: `src/db/schema.ts`
- Create: `src/db/schema.test.ts`

先安装依赖：

```bash
cd ~/Codes/GeminiClaw && pnpm add better-sqlite3 && pnpm add -D @types/better-sqlite3
```

- [ ] **Step 1: 写失败测试**

```typescript
// src/db/schema.test.ts
import { it, expect, afterEach } from "vitest"
import { existsSync, rmSync } from "fs"
import { join } from "path"
import { openDb, migrate } from "./schema.js"

const TEST_DB = "/tmp/geminiclaw-test-schema.db"

afterEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB)
})

it("creates all tables on migrate", () => {
  const db = openDb(TEST_DB)
  migrate(db)

  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
  ).all() as Array<{ name: string }>

  const names = tables.map(t => t.name)
  expect(names).toContain("chat_sessions")
  expect(names).toContain("chat_messages")
  expect(names).toContain("memory_topics")
  db.close()
})

it("migrate is idempotent", () => {
  const db = openDb(TEST_DB)
  migrate(db)
  migrate(db)  // 第二次不应报错
  db.close()
})

it("can insert and query chat_messages", () => {
  const db = openDb(TEST_DB)
  migrate(db)

  db.prepare(`INSERT INTO chat_sessions (id, title) VALUES (?, ?)`).run("s1", "test session")
  db.prepare(`INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)`).run("s1", "user", "hello")

  const msgs = db.prepare(`SELECT * FROM chat_messages WHERE session_id = ?`).all("s1") as Array<{ role: string; content: string }>
  expect(msgs).toHaveLength(1)
  expect(msgs[0].role).toBe("user")
  expect(msgs[0].content).toBe("hello")
  db.close()
})

it("can insert and query memory_topics", () => {
  const db = openDb(TEST_DB)
  migrate(db)

  db.prepare(`
    INSERT INTO memory_topics (id, title, summary, active)
    VALUES (?, ?, ?, ?)
  `).run("topic_001", "GeminiClaw 开发进度", "正在构建记忆系统", 1)

  const topic = db.prepare(`SELECT * FROM memory_topics WHERE id = ?`).get("topic_001") as { title: string; active: number }
  expect(topic.title).toBe("GeminiClaw 开发进度")
  expect(topic.active).toBe(1)
  db.close()
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/db/schema.test.ts 2>&1 | tail -10
```
Expected: FAIL — `Cannot find module './schema.js'`

- [ ] **Step 3: 实现 src/db/client.ts**

```typescript
// src/db/client.ts
import Database from "better-sqlite3"
import { mkdirSync } from "fs"
import { dirname } from "path"

export type Db = Database.Database

export function openDb(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  return db
}
```

- [ ] **Step 4: 实现 src/db/schema.ts**

```typescript
// src/db/schema.ts
import type { Db } from "./client.js"
export { openDb } from "./client.js"

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id            TEXT PRIMARY KEY,
      title         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      message_count INTEGER NOT NULL DEFAULT 0,
      topic_ids     TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_session
      ON chat_messages(session_id, id);

    CREATE TABLE IF NOT EXISTS memory_topics (
      id               TEXT PRIMARY KEY,
      title            TEXT NOT NULL,
      summary          TEXT,
      doc_level2       TEXT,
      doc_level3       TEXT,
      doc_size         INTEGER NOT NULL DEFAULT 0,
      active           INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
      access_count     INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_memory_topics_active
      ON memory_topics(active, last_accessed_at);
  `)
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/db/schema.test.ts 2>&1 | tail -10
```
Expected: 4 tests PASS

- [ ] **Step 6: 全量测试**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -10
```
Expected: all pass

- [ ] **Step 7: commit**

```bash
cd ~/Codes/GeminiClaw && git add src/db/client.ts src/db/schema.ts src/db/schema.test.ts
git commit -m "feat: add SQLite db layer (client + schema + migrate)"
```

---

## Task 4: MemoryStrategy 接口 + BufferStrategy

**Files:**
- Create: `src/memory/strategy.ts`
- Create: `src/memory/strategies/buffer.ts`
- Create: `src/memory/strategies/buffer.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/memory/strategies/buffer.test.ts
import { it, expect, beforeEach } from "vitest"
import { BufferStrategy } from "./buffer.js"
import type { Message } from "../../providers/types.js"

let strategy: BufferStrategy

beforeEach(() => {
  strategy = new BufferStrategy({ recentMessageLimit: 4 })
})

it("getContext returns empty messages for unknown session", async () => {
  const ctx = await strategy.getContext("unknown", "hi")
  expect(ctx.messages).toEqual([])
})

it("appendTurn stores user and assistant messages", async () => {
  await strategy.appendTurn("s1", { role: "user", content: "hello" }, { role: "assistant", content: "hi" })
  const ctx = await strategy.getContext("s1", "next")
  expect(ctx.messages).toHaveLength(2)
  expect(ctx.messages[0].role).toBe("user")
  expect(ctx.messages[1].role).toBe("assistant")
})

it("respects recentMessageLimit", async () => {
  for (let i = 0; i < 6; i++) {
    await strategy.appendTurn(
      "s1",
      { role: "user", content: `msg ${i}` },
      { role: "assistant", content: `reply ${i}` }
    )
  }
  const ctx = await strategy.getContext("s1", "next")
  // limit=4 means last 4 messages (2 turns)
  expect(ctx.messages).toHaveLength(4)
  expect(ctx.messages[0].content).toBe("msg 4")
})

it("ensureSession is idempotent", async () => {
  await strategy.ensureSession("s1")
  await strategy.ensureSession("s1")
  const ctx = await strategy.getContext("s1", "hi")
  expect(ctx.messages).toEqual([])
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/memory/strategies/buffer.test.ts 2>&1 | tail -10
```
Expected: FAIL — `Cannot find module './buffer.js'`

- [ ] **Step 3: 定义 MemoryStrategy 接口**

```typescript
// src/memory/strategy.ts
import type { Message } from "../providers/types.js"

export interface ConversationContext {
  /** 注入给主模型的消息列表（含 system、历史、当前消息前的所有内容） */
  messages: Message[]
  /** 调试/日志用：使用了哪个策略 */
  strategyName: string
}

export interface MemoryStrategy {
  readonly name: string
  /** 确保 session 存在（幂等） */
  ensureSession(sessionId: string): Promise<void>
  /** 根据当前用户消息，组装注入主模型的 context */
  getContext(sessionId: string, userMessage: string): Promise<ConversationContext>
  /** 主模型回复后，追加本轮对话并触发后台异步处理 */
  appendTurn(sessionId: string, userMsg: Message, assistantMsg: Message): Promise<void>
}
```

- [ ] **Step 4: 实现 BufferStrategy**

```typescript
// src/memory/strategies/buffer.ts
import type { Message } from "../../providers/types.js"
import type { MemoryStrategy, ConversationContext } from "../strategy.js"

interface BufferStrategyConfig {
  recentMessageLimit: number
}

export class BufferStrategy implements MemoryStrategy {
  readonly name = "buffer"
  private sessions: Map<string, Message[]> = new Map()
  private limit: number

  constructor(config: BufferStrategyConfig) {
    this.limit = config.recentMessageLimit
  }

  async ensureSession(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, [])
    }
  }

  async getContext(sessionId: string, _userMessage: string): Promise<ConversationContext> {
    const all = this.sessions.get(sessionId) ?? []
    const messages = all.slice(-this.limit)
    return { messages, strategyName: this.name }
  }

  async appendTurn(sessionId: string, userMsg: Message, assistantMsg: Message): Promise<void> {
    await this.ensureSession(sessionId)
    const existing = this.sessions.get(sessionId)!
    existing.push(userMsg, assistantMsg)
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/memory/strategies/buffer.test.ts 2>&1 | tail -10
```
Expected: 4 tests PASS

- [ ] **Step 6: 全量测试**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -10
```
Expected: all pass

- [ ] **Step 7: commit**

```bash
cd ~/Codes/GeminiClaw && git add src/memory/strategy.ts src/memory/strategies/buffer.ts src/memory/strategies/buffer.test.ts
git commit -m "feat: add MemoryStrategy interface + BufferStrategy"
```

---

## Task 5: TopicRouter（路由模块）

**Files:**
- Create: `src/memory/router.ts`
- Create: `src/memory/router.test.ts`

TopicRouter 调用 friday/gemini-flash，输入用户消息 + 最近3条对话 + 活跃事项列表，输出匹配事项 ID 列表 + 置信度。

- [ ] **Step 1: 写失败测试**

```typescript
// src/memory/router.test.ts
import { it, expect, vi, beforeEach } from "vitest"
import type { Provider } from "../providers/types.js"

function makeProvider(responseText: string): Provider {
  return {
    name: "friday",
    chat: vi.fn().mockResolvedValue({ content: responseText, model: "gemini-flash" }),
    stream: vi.fn(),
  } as unknown as Provider
}

it("returns empty match when no topics", async () => {
  const { TopicRouter } = await import("./router.js")
  const router = new TopicRouter(makeProvider("{}"))
  const result = await router.route("hello", [], [])
  expect(result.matches).toEqual([])
  expect(result.confidence).toBe(0)
})

it("parses valid JSON response from model", async () => {
  const { TopicRouter } = await import("./router.js")
  const responseJson = JSON.stringify({
    matches: [{ topicId: "topic_001", confidence: 0.85, level: 2 }],
    confidence: 0.85,
  })
  const router = new TopicRouter(makeProvider(responseJson))

  const topics = [{ id: "topic_001", title: "GeminiClaw 开发", summary: "构建记忆系统" }]
  const result = await router.route("记忆系统进展怎么样了", [], topics)

  expect(result.matches).toHaveLength(1)
  expect(result.matches[0].topicId).toBe("topic_001")
  expect(result.matches[0].confidence).toBeCloseTo(0.85)
  expect(result.confidence).toBeCloseTo(0.85)
})

it("returns empty match on malformed JSON", async () => {
  const { TopicRouter } = await import("./router.js")
  const router = new TopicRouter(makeProvider("not json at all"))
  const topics = [{ id: "topic_001", title: "test", summary: "test" }]
  const result = await router.route("hi", [], topics)
  expect(result.matches).toEqual([])
  expect(result.confidence).toBe(0)
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/memory/router.test.ts 2>&1 | tail -10
```
Expected: FAIL — `Cannot find module './router.js'`

- [ ] **Step 3: 实现 TopicRouter**

```typescript
// src/memory/router.ts
import type { Provider, Message } from "../providers/types.js"

export interface TopicSummary {
  id: string
  title: string
  summary: string | null
}

export interface TopicMatch {
  topicId: string
  confidence: number
  level: 1 | 2 | 3   // 建议加载的文档层级
}

export interface RouteResult {
  matches: TopicMatch[]
  confidence: number  // 整体置信度（最高 match 的置信度，无 match 时为 0）
}

const ROUTE_SYSTEM_PROMPT = `你是一个对话主题路由助手。
给定用户的最新消息、最近的对话历史、以及一组活跃事项列表，
判断本次消息与哪些事项相关，以及需要加载的文档详细程度（1=摘要/2=概览/3=详情）。

输出严格的 JSON，格式如下：
{
  "matches": [
    { "topicId": "<id>", "confidence": 0.0-1.0, "level": 1|2|3 }
  ],
  "confidence": 0.0-1.0
}

规则：
- 若消息与事项无关（闲聊/单次问答），返回 { "matches": [], "confidence": 0 }
- confidence < 0.7 时 level 最高取 2
- 最多返回 3 个 match
- 只输出 JSON，不要解释`

export class TopicRouter {
  private provider: Provider

  constructor(provider: Provider) {
    this.provider = provider
  }

  async route(
    userMessage: string,
    recentHistory: Message[],
    activeTopics: TopicSummary[],
  ): Promise<RouteResult> {
    if (activeTopics.length === 0) {
      return { matches: [], confidence: 0 }
    }

    const topicsText = activeTopics
      .map(t => `- [${t.id}] ${t.title}：${t.summary ?? "（无摘要）"}`)
      .join("\n")

    const historyText = recentHistory
      .slice(-3)
      .map(m => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
      .join("\n")

    const userPrompt = [
      historyText ? `最近对话：\n${historyText}\n` : "",
      `当前消息：${userMessage}`,
      `\n活跃事项列表：\n${topicsText}`,
    ].join("")

    const messages: Message[] = [
      { role: "system", content: ROUTE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ]

    try {
      const resp = await this.provider.chat(messages, { maxTokens: 512, temperature: 0 })
      const parsed = JSON.parse(resp.content) as RouteResult
      return {
        matches: Array.isArray(parsed.matches) ? parsed.matches : [],
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      }
    } catch {
      return { matches: [], confidence: 0 }
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/memory/router.test.ts 2>&1 | tail -10
```
Expected: 3 tests PASS

- [ ] **Step 5: 全量测试**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -10
```
Expected: all pass

- [ ] **Step 6: commit**

```bash
cd ~/Codes/GeminiClaw && git add src/memory/router.ts src/memory/router.test.ts
git commit -m "feat: add TopicRouter (friday-flash routing with confidence)"
```

---

## Task 6: TriageService（立项模块）

**Files:**
- Create: `src/memory/triage.ts`
- Create: `src/memory/triage.test.ts`

TriageService 在累计 N 轮后调用 friday-flash，判断是否立项，输出：归入已有事项 / 创建新事项 / 不立项。

- [ ] **Step 1: 写失败测试**

```typescript
// src/memory/triage.test.ts
import { it, expect, vi } from "vitest"
import type { Provider } from "../providers/types.js"

function makeProvider(responseText: string): Provider {
  return {
    name: "friday",
    chat: vi.fn().mockResolvedValue({ content: responseText, model: "gemini-flash" }),
    stream: vi.fn(),
  } as unknown as Provider
}

it("returns skip when turns below threshold", async () => {
  const { TriageService } = await import("./triage.js")
  const svc = new TriageService(makeProvider("{}"), { triageAfterTurns: 3 })

  // 只有 2 轮（4 条消息），不触发
  const msgs = [
    { role: "user" as const, content: "hi" },
    { role: "assistant" as const, content: "hello" },
    { role: "user" as const, content: "how are you" },
    { role: "assistant" as const, content: "fine" },
  ]
  const result = await svc.triage("s1", msgs, [])
  expect(result.action).toBe("skip")
})

it("returns new_topic when model suggests creating", async () => {
  const { TriageService } = await import("./triage.js")
  const responseJson = JSON.stringify({
    action: "new_topic",
    title: "GeminiClaw 记忆系统设计",
    summary: "讨论了分层记忆架构和 SQLite 存储方案",
  })
  const svc = new TriageService(makeProvider(responseJson), { triageAfterTurns: 2 })

  const msgs = Array.from({ length: 4 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `msg ${i}`,
  }))
  const result = await svc.triage("s1", msgs, [])
  expect(result.action).toBe("new_topic")
  if (result.action === "new_topic") {
    expect(result.title).toBe("GeminiClaw 记忆系统设计")
    expect(result.summary).toBe("讨论了分层记忆架构和 SQLite 存储方案")
  }
})

it("returns merge_topic when model suggests merging", async () => {
  const { TriageService } = await import("./triage.js")
  const responseJson = JSON.stringify({ action: "merge_topic", topicId: "topic_001" })
  const svc = new TriageService(makeProvider(responseJson), { triageAfterTurns: 2 })

  const msgs = Array.from({ length: 4 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `msg ${i}`,
  }))
  const topics = [{ id: "topic_001", title: "GeminiClaw 开发", summary: "已有事项" }]
  const result = await svc.triage("s1", msgs, topics)
  expect(result.action).toBe("merge_topic")
  if (result.action === "merge_topic") {
    expect(result.topicId).toBe("topic_001")
  }
})

it("returns skip on malformed JSON from model", async () => {
  const { TriageService } = await import("./triage.js")
  const svc = new TriageService(makeProvider("not json"), { triageAfterTurns: 2 })
  const msgs = Array.from({ length: 4 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `msg ${i}`,
  }))
  const result = await svc.triage("s1", msgs, [])
  expect(result.action).toBe("skip")
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/memory/triage.test.ts 2>&1 | tail -10
```
Expected: FAIL — `Cannot find module './triage.js'`

- [ ] **Step 3: 实现 TriageService**

```typescript
// src/memory/triage.ts
import type { Provider, Message } from "../providers/types.js"
import type { TopicSummary } from "./router.js"

export type TriageResult =
  | { action: "skip" }
  | { action: "new_topic"; title: string; summary: string }
  | { action: "merge_topic"; topicId: string }

interface TriageConfig {
  triageAfterTurns: number
}

const TRIAGE_SYSTEM_PROMPT = `你是一个对话立项助手。
给定一段对话历史和当前活跃事项列表，判断这段对话是否值得建立或归入一个事项。

输出严格的 JSON，格式为以下三种之一：
1. 不值得立项（闲聊/单次问答）：{ "action": "skip" }
2. 归入已有事项：{ "action": "merge_topic", "topicId": "<id>" }
3. 创建新事项：{ "action": "new_topic", "title": "<动作+对象，20字内>", "summary": "<2-3句摘要>" }

规则：
- 标题格式：动作 + 对象，例如"GeminiClaw 记忆系统设计"、"Spark AQE 调优分析"
- 闲聊、单次问答、确认类消息 → skip
- 只输出 JSON，不要解释`

export class TriageService {
  private provider: Provider
  private threshold: number

  constructor(provider: Provider, config: TriageConfig) {
    this.provider = provider
    this.threshold = config.triageAfterTurns
  }

  async triage(
    _sessionId: string,
    messages: Message[],
    activeTopics: TopicSummary[],
  ): Promise<TriageResult> {
    // 轮数 = user 消息数
    const turns = messages.filter(m => m.role === "user").length
    if (turns < this.threshold) {
      return { action: "skip" }
    }

    const historyText = messages
      .map(m => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
      .join("\n")

    const topicsText = activeTopics.length > 0
      ? `\n当前活跃事项：\n` + activeTopics.map(t => `- [${t.id}] ${t.title}`).join("\n")
      : ""

    const userPrompt = `对话历史：\n${historyText}${topicsText}`

    const msgs: Message[] = [
      { role: "system", content: TRIAGE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ]

    try {
      const resp = await this.provider.chat(msgs, { maxTokens: 256, temperature: 0 })
      const parsed = JSON.parse(resp.content) as TriageResult
      if (!parsed.action) return { action: "skip" }
      return parsed
    } catch {
      return { action: "skip" }
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/memory/triage.test.ts 2>&1 | tail -10
```
Expected: 4 tests PASS

- [ ] **Step 5: 全量测试**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -10
```
Expected: all pass

- [ ] **Step 6: commit**

```bash
cd ~/Codes/GeminiClaw && git add src/memory/triage.ts src/memory/triage.test.ts
git commit -m "feat: add TriageService (topic creation/merge judgment)"
```

---

## Task 7: context 组装（buildContext）

**Files:**
- Create: `src/memory/context.ts`
- Create: `src/memory/context.test.ts`

buildContext 负责把活跃事项索引 + 按需文档层 + 近期对话组装成注入主模型的消息列表。

- [ ] **Step 1: 写失败测试**

```typescript
// src/memory/context.test.ts
import { it, expect } from "vitest"
import type { Message } from "../providers/types.js"

it("returns only recent messages when no topics", async () => {
  const { buildContext } = await import("./context.js")
  const history: Message[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ]
  const ctx = buildContext({
    systemPrompt: "You are helpful.",
    activeTopics: [],
    topicDocs: [],
    recentHistory: history,
    userMessage: "how are you",
    recentMessageLimit: 20,
  })
  // system + history
  expect(ctx[0].role).toBe("system")
  expect(ctx[0].content).toContain("You are helpful.")
  expect(ctx.slice(1)).toEqual(history)
})

it("injects active topic index into system prompt", async () => {
  const { buildContext } = await import("./context.js")
  const topics = [
    { id: "t1", title: "GeminiClaw 开发", summary: "构建记忆系统" },
    { id: "t2", title: "Spark 调优", summary: "分析 shuffle 瓶颈" },
  ]
  const ctx = buildContext({
    systemPrompt: "You are helpful.",
    activeTopics: topics,
    topicDocs: [],
    recentHistory: [],
    userMessage: "hi",
    recentMessageLimit: 20,
  })
  expect(ctx[0].role).toBe("system")
  expect(ctx[0].content).toContain("GeminiClaw 开发")
  expect(ctx[0].content).toContain("Spark 调优")
})

it("appends topic docs as system messages", async () => {
  const { buildContext } = await import("./context.js")
  const docs = [
    { topicId: "t1", title: "GeminiClaw 开发", level: 2 as const, content: "详细概览内容" },
  ]
  const ctx = buildContext({
    systemPrompt: "You are helpful.",
    activeTopics: [{ id: "t1", title: "GeminiClaw 开发", summary: "构建记忆系统" }],
    topicDocs: docs,
    recentHistory: [],
    userMessage: "hi",
    recentMessageLimit: 20,
  })
  const systemMsgs = ctx.filter(m => m.role === "system")
  expect(systemMsgs.some(m => m.content.includes("详细概览内容"))).toBe(true)
})

it("trims history to recentMessageLimit", async () => {
  const { buildContext } = await import("./context.js")
  const history: Message[] = Array.from({ length: 30 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `msg ${i}`,
  }))
  const ctx = buildContext({
    systemPrompt: "",
    activeTopics: [],
    topicDocs: [],
    recentHistory: history,
    userMessage: "hi",
    recentMessageLimit: 10,
  })
  const nonSystem = ctx.filter(m => m.role !== "system")
  expect(nonSystem).toHaveLength(10)
  expect(nonSystem[0].content).toBe("msg 20")
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/memory/context.test.ts 2>&1 | tail -10
```
Expected: FAIL — `Cannot find module './context.js'`

- [ ] **Step 3: 实现 buildContext**

```typescript
// src/memory/context.ts
import type { Message } from "../providers/types.js"
import type { TopicSummary } from "./router.js"

export interface TopicDoc {
  topicId: string
  title: string
  level: 1 | 2 | 3
  content: string
}

export interface BuildContextOptions {
  systemPrompt: string
  activeTopics: TopicSummary[]
  topicDocs: TopicDoc[]
  recentHistory: Message[]
  userMessage: string
  recentMessageLimit: number
}

export function buildContext(opts: BuildContextOptions): Message[] {
  const { systemPrompt, activeTopics, topicDocs, recentHistory, recentMessageLimit } = opts
  const result: Message[] = []

  // 1. system prompt + 活跃事项索引
  let systemContent = systemPrompt
  if (activeTopics.length > 0) {
    const indexText = activeTopics
      .map(t => `- [${t.id}] ${t.title}：${t.summary ?? "（无摘要）"}`)
      .join("\n")
    systemContent += `\n\n## 当前活跃事项（${activeTopics.length} 个）\n${indexText}`
  }
  result.push({ role: "system", content: systemContent })

  // 2. 相关事项文档（按需，每个事项一条 system 消息）
  for (const doc of topicDocs) {
    result.push({
      role: "system",
      content: `## 事项详情：${doc.title}（第${doc.level}级）\n${doc.content}`,
    })
  }

  // 3. 近期对话（滑动窗口）
  const trimmed = recentHistory.slice(-recentMessageLimit)
  result.push(...trimmed)

  return result
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/memory/context.test.ts 2>&1 | tail -10
```
Expected: 4 tests PASS

- [ ] **Step 5: 全量测试**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -10
```
Expected: all pass

- [ ] **Step 6: commit**

```bash
cd ~/Codes/GeminiClaw && git add src/memory/context.ts src/memory/context.test.ts
git commit -m "feat: add buildContext (system + topic index + docs + history)"
```

---

## Task 8: BackgroundService（摘要 + Compact + 清理）

**Files:**
- Create: `src/memory/background.ts`
- Create: `src/memory/background.test.ts`

BackgroundService 在每轮对话后异步执行：生成摘要 → 更新事项文档（Compact）→ 检查并清理超出上限的事项。

- [ ] **Step 1: 写失败测试**

```typescript
// src/memory/background.test.ts
import { it, expect, vi } from "vitest"
import type { Provider } from "../providers/types.js"
import type { Db } from "../db/client.js"
import { openDb, migrate } from "../db/schema.js"
import { existsSync, rmSync } from "fs"

const TEST_DB = "/tmp/geminiclaw-test-background.db"

function makeProvider(summary: string): Provider {
  return {
    name: "friday",
    chat: vi.fn().mockResolvedValue({ content: summary, model: "gemini-flash" }),
    stream: vi.fn(),
  } as unknown as Provider
}

function makeDb(): Db {
  if (existsSync(TEST_DB)) rmSync(TEST_DB)
  const db = openDb(TEST_DB)
  migrate(db)
  return db
}

it("summarize returns text from provider", async () => {
  const { BackgroundService } = await import("./background.js")
  const svc = new BackgroundService(makeProvider("这是摘要"), makeDb(), {
    compactThresholdBytes: 6144,
    maxActiveTopics: 16,
  })
  const summary = await svc.summarize(
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  )
  expect(summary).toBe("这是摘要")
})

it("appendToTopic creates new topic doc when not exists", async () => {
  const db = makeDb()
  const { BackgroundService } = await import("./background.js")
  const svc = new BackgroundService(makeProvider("摘要"), db, {
    compactThresholdBytes: 6144,
    maxActiveTopics: 16,
  })

  db.prepare(`INSERT INTO memory_topics (id, title, summary) VALUES (?, ?, ?)`).run("t1", "测试事项", "初始摘要")
  await svc.appendToTopic("t1", "新增内容")

  const topic = db.prepare(`SELECT * FROM memory_topics WHERE id = ?`).get("t1") as { doc_level2: string }
  expect(topic.doc_level2).toContain("新增内容")
})

it("evictIfNeeded removes least-active topic when over limit", async () => {
  const db = makeDb()
  const { BackgroundService } = await import("./background.js")
  const svc = new BackgroundService(makeProvider("摘要"), db, {
    compactThresholdBytes: 6144,
    maxActiveTopics: 2,  // 上限设为 2，方便测试
  })

  // 插入 3 个活跃事项
  for (let i = 1; i <= 3; i++) {
    db.prepare(`
      INSERT INTO memory_topics (id, title, summary, active, last_accessed_at, access_count)
      VALUES (?, ?, ?, 1, datetime('now', ?), ?)
    `).run(`t${i}`, `事项${i}`, `摘要${i}`, `-${i * 10} minutes`, i)
  }

  await svc.evictIfNeeded()

  const active = db.prepare(`SELECT id FROM memory_topics WHERE active = 1`).all() as Array<{ id: string }>
  expect(active).toHaveLength(2)
  // t1 是最老的（-10 分钟，最低 access_count=1），应该被清理
  expect(active.map(t => t.id)).not.toContain("t1")
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/memory/background.test.ts 2>&1 | tail -10
```
Expected: FAIL — `Cannot find module './background.js'`

- [ ] **Step 3: 实现 BackgroundService**

```typescript
// src/memory/background.ts
import type { Provider, Message } from "../providers/types.js"
import type { Db } from "../db/client.js"

interface BackgroundConfig {
  compactThresholdBytes: number
  maxActiveTopics: number
}

const SUMMARIZE_SYSTEM = `你是一个对话摘要助手。
给定一轮对话（用户消息 + 助手回复），用 2-3 句话概括核心内容。
只输出摘要文本，不要加标题或格式。`

const COMPACT_SYSTEM = `你是一个文档压缩助手。
给定一份事项文档（可能很长），将其压缩成原来 40% 左右的篇幅，保留所有关键信息，去除重复和冗余内容。
只输出压缩后的文档内容，不要加标题或说明。`

export class BackgroundService {
  private provider: Provider
  private db: Db
  private config: BackgroundConfig

  constructor(provider: Provider, db: Db, config: BackgroundConfig) {
    this.provider = provider
    this.db = db
    this.config = config
  }

  async summarize(userMsg: Message, assistantMsg: Message): Promise<string> {
    const msgs: Message[] = [
      { role: "system", content: SUMMARIZE_SYSTEM },
      { role: "user", content: `用户：${userMsg.content}\n助手：${assistantMsg.content}` },
    ]
    const resp = await this.provider.chat(msgs, { maxTokens: 256, temperature: 0 })
    return resp.content.trim()
  }

  async appendToTopic(topicId: string, content: string): Promise<void> {
    const topic = this.db.prepare(
      `SELECT doc_level2, doc_size FROM memory_topics WHERE id = ?`
    ).get(topicId) as { doc_level2: string | null; doc_size: number } | undefined

    if (!topic) return

    const existing = topic.doc_level2 ?? ""
    const newContent = existing ? `${existing}\n\n${content}` : content
    const newSize = Buffer.byteLength(newContent, "utf8")

    if (newSize >= this.config.compactThresholdBytes) {
      // 触发 Compact：调摘要模型压缩
      const compacted = await this.compact(newContent)
      const compactedSize = Buffer.byteLength(compacted, "utf8")
      this.db.prepare(`
        UPDATE memory_topics
        SET doc_level2 = ?, doc_size = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(compacted, compactedSize, topicId)
    } else {
      this.db.prepare(`
        UPDATE memory_topics
        SET doc_level2 = ?, doc_size = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(newContent, newSize, topicId)
    }
  }

  private async compact(content: string): Promise<string> {
    const msgs: Message[] = [
      { role: "system", content: COMPACT_SYSTEM },
      { role: "user", content: content },
    ]
    const resp = await this.provider.chat(msgs, { maxTokens: 2048, temperature: 0 })
    return resp.content.trim()
  }

  async evictIfNeeded(): Promise<void> {
    const activeCount = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM memory_topics WHERE active = 1`
    ).get() as { cnt: number }).cnt

    if (activeCount <= this.config.maxActiveTopics) return

    // 计算清理分数：时间权重 0.6 + 访问频率权重 0.3 + 大小权重 0.1
    // 分数越高越先清理（最不活跃）
    const toEvict = this.db.prepare(`
      SELECT id,
        (
          (julianday('now') - julianday(last_accessed_at)) / 90.0 * 0.6
          + (1.0 - CAST(access_count AS REAL) / MAX(access_count) OVER ()) * 0.3
          + (CAST(doc_size AS REAL) / 10240.0) * 0.1
        ) AS score
      FROM memory_topics
      WHERE active = 1
      ORDER BY score DESC
      LIMIT ?
    `).all(activeCount - this.config.maxActiveTopics) as Array<{ id: string }>

    for (const { id } of toEvict) {
      this.db.prepare(`
        UPDATE memory_topics SET active = 0, updated_at = datetime('now') WHERE id = ?
      `).run(id)
    }
  }

  /** 对话结束后调用，异步执行全部后台任务（不阻塞响应） */
  runAsync(
    topicId: string | null,
    userMsg: Message,
    assistantMsg: Message,
  ): void {
    // fire-and-forget，错误只记录不抛出
    Promise.resolve().then(async () => {
      try {
        const summary = await this.summarize(userMsg, assistantMsg)
        if (topicId) {
          await this.appendToTopic(topicId, summary)
        }
        await this.evictIfNeeded()
      } catch (err) {
        console.error("[BackgroundService] error:", err)
      }
    })
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/memory/background.test.ts 2>&1 | tail -10
```
Expected: 3 tests PASS

- [ ] **Step 5: 全量测试**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -10
```
Expected: all pass

- [ ] **Step 6: commit**

```bash
cd ~/Codes/GeminiClaw && git add src/memory/background.ts src/memory/background.test.ts
git commit -m "feat: add BackgroundService (summarize + compact + evict)"
```

---

## Task 9: LayeredStrategy（分层 topics 完整策略）

**Files:**
- Create: `src/memory/strategies/layered.ts`
- Create: `src/memory/strategies/layered.test.ts`

LayeredStrategy 把 TopicRouter + TriageService + BackgroundService + buildContext 串联起来，实现完整的分层记忆策略。

- [ ] **Step 1: 写失败测试**

```typescript
// src/memory/strategies/layered.test.ts
import { it, expect, vi, afterEach } from "vitest"
import { existsSync, rmSync } from "fs"
import { openDb, migrate } from "../../db/schema.js"
import type { Provider } from "../../providers/types.js"

const TEST_DB = "/tmp/geminiclaw-test-layered.db"

afterEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB)
})

function makeProvider(response: string): Provider {
  return {
    name: "friday",
    chat: vi.fn().mockResolvedValue({ content: response, model: "gemini-flash" }),
    stream: vi.fn(),
  } as unknown as Provider
}

function makeDb() {
  const db = openDb(TEST_DB)
  migrate(db)
  return db
}

it("getContext returns system message with empty topic index for new session", async () => {
  const { LayeredStrategy } = await import("./layered.js")
  const db = makeDb()
  const routerProvider = makeProvider(JSON.stringify({ matches: [], confidence: 0 }))
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
  const ctx = await strategy.getContext("s1", "hello")
  expect(ctx.strategyName).toBe("layered")
  expect(ctx.messages[0].role).toBe("system")
})

it("appendTurn persists messages to SQLite", async () => {
  const { LayeredStrategy } = await import("./layered.js")
  const db = makeDb()
  const routerProvider = makeProvider(JSON.stringify({ matches: [], confidence: 0 }))
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
  await strategy.appendTurn(
    "s1",
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  )

  const msgs = db.prepare(`SELECT * FROM chat_messages WHERE session_id = ?`).all("s1") as Array<{ role: string; content: string }>
  expect(msgs).toHaveLength(2)
  expect(msgs[0].role).toBe("user")
  expect(msgs[1].role).toBe("assistant")
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/memory/strategies/layered.test.ts 2>&1 | tail -10
```
Expected: FAIL — `Cannot find module './layered.js'`

- [ ] **Step 3: 实现 LayeredStrategy**

```typescript
// src/memory/strategies/layered.ts
import { randomUUID } from "crypto"
import type { Message } from "../../providers/types.js"
import type { MemoryStrategy, ConversationContext } from "../strategy.js"
import type { Db } from "../../db/client.js"
import type { Provider } from "../../providers/types.js"
import { TopicRouter } from "../router.js"
import { TriageService } from "../triage.js"
import { BackgroundService } from "../background.js"
import { buildContext } from "../context.js"
import type { TopicSummary } from "../router.js"

interface LayeredStrategyConfig {
  db: Db
  routerProvider: Provider
  triageProvider: Provider
  systemPrompt: string
  recentMessageLimit: number
  triageAfterTurns: number
  compactThresholdBytes: number
  maxActiveTopics: number
}

export class LayeredStrategy implements MemoryStrategy {
  readonly name = "layered"
  private db: Db
  private router: TopicRouter
  private triage: TriageService
  private background: BackgroundService
  private config: LayeredStrategyConfig

  constructor(config: LayeredStrategyConfig) {
    this.db = config.db
    this.config = config
    this.router = new TopicRouter(config.routerProvider)
    this.triage = new TriageService(config.triageProvider, {
      triageAfterTurns: config.triageAfterTurns,
    })
    this.background = new BackgroundService(config.triageProvider, config.db, {
      compactThresholdBytes: config.compactThresholdBytes,
      maxActiveTopics: config.maxActiveTopics,
    })
  }

  async ensureSession(sessionId: string): Promise<void> {
    const exists = this.db.prepare(`SELECT id FROM chat_sessions WHERE id = ?`).get(sessionId)
    if (!exists) {
      this.db.prepare(`INSERT INTO chat_sessions (id, title) VALUES (?, ?)`).run(sessionId, null)
    }
  }

  async getContext(sessionId: string, userMessage: string): Promise<ConversationContext> {
    await this.ensureSession(sessionId)

    // 1. 获取活跃事项索引
    const activeTopics = this.db.prepare(`
      SELECT id, title, summary FROM memory_topics WHERE active = 1
      ORDER BY last_accessed_at DESC LIMIT 16
    `).all() as TopicSummary[]

    // 2. 路由：找匹配事项
    const recentHistory = this.getRecentHistory(sessionId)
    const routeResult = await this.router.route(userMessage, recentHistory, activeTopics)

    // 3. 按需加载事项文档
    const topicDocs = []
    for (const match of routeResult.matches) {
      const topic = this.db.prepare(`
        SELECT id, title, summary, doc_level2, doc_level3 FROM memory_topics WHERE id = ?
      `).get(match.topicId) as {
        id: string; title: string; summary: string | null;
        doc_level2: string | null; doc_level3: string | null
      } | undefined

      if (!topic) continue

      // 更新访问记录
      this.db.prepare(`
        UPDATE memory_topics
        SET last_accessed_at = datetime('now'), access_count = access_count + 1
        WHERE id = ?
      `).run(match.topicId)

      const level = match.confidence < 0.7 ? Math.min(match.level, 2) as 1 | 2 | 3 : match.level
      const content = level === 3
        ? (topic.doc_level3 ?? topic.doc_level2 ?? topic.summary ?? "")
        : level === 2
          ? (topic.doc_level2 ?? topic.summary ?? "")
          : (topic.summary ?? "")

      if (content) {
        topicDocs.push({ topicId: topic.id, title: topic.title, level, content })
      }
    }

    // 4. 组装 context
    const messages = buildContext({
      systemPrompt: this.config.systemPrompt,
      activeTopics,
      topicDocs,
      recentHistory,
      userMessage,
      recentMessageLimit: this.config.recentMessageLimit,
    })

    return { messages, strategyName: this.name }
  }

  async appendTurn(sessionId: string, userMsg: Message, assistantMsg: Message): Promise<void> {
    await this.ensureSession(sessionId)

    // 持久化消息
    this.db.prepare(`
      INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)
    `).run(sessionId, userMsg.role, userMsg.content)
    this.db.prepare(`
      INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)
    `).run(sessionId, assistantMsg.role, assistantMsg.content)

    // 更新 session 计数
    this.db.prepare(`
      UPDATE chat_sessions SET message_count = message_count + 2, updated_at = datetime('now') WHERE id = ?
    `).run(sessionId)

    // 立项判断
    const allMessages = this.db.prepare(`
      SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id
    `).all(sessionId) as Message[]

    const activeTopics = this.db.prepare(`
      SELECT id, title, summary FROM memory_topics WHERE active = 1
    `).all() as TopicSummary[]

    const triageResult = await this.triage.triage(sessionId, allMessages, activeTopics)

    let topicId: string | null = null
    if (triageResult.action === "new_topic") {
      topicId = `topic_${randomUUID().replace(/-/g, "").slice(0, 12)}`
      this.db.prepare(`
        INSERT INTO memory_topics (id, title, summary) VALUES (?, ?, ?)
      `).run(topicId, triageResult.title, triageResult.summary)
    } else if (triageResult.action === "merge_topic") {
      topicId = triageResult.topicId
    }

    // 后台异步：摘要 + Compact + 清理
    this.background.runAsync(topicId, userMsg, assistantMsg)
  }

  private getRecentHistory(sessionId: string): Message[] {
    return this.db.prepare(`
      SELECT role, content FROM chat_messages
      WHERE session_id = ?
      ORDER BY id DESC LIMIT ?
    `).all(sessionId, this.config.recentMessageLimit) as Message[]
    // Note: DESC 取最新，需要 reverse
  }
}
```

注意：`getRecentHistory` 用 DESC 取了最新的，需要在 `getContext` 里 reverse 一下，修正：

在 `getContext` 方法中，把：
```typescript
const recentHistory = this.getRecentHistory(sessionId)
```
改为：
```typescript
const recentHistory = this.getRecentHistory(sessionId).reverse()
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/memory/strategies/layered.test.ts 2>&1 | tail -10
```
Expected: 2 tests PASS

- [ ] **Step 5: 全量测试**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -10
```
Expected: all pass

- [ ] **Step 6: commit**

```bash
cd ~/Codes/GeminiClaw && git add src/memory/strategies/layered.ts src/memory/strategies/layered.test.ts
git commit -m "feat: add LayeredStrategy (full topic-based memory)"
```

---

## Task 10: buildStrategy 工厂 + chat route 改造 + server 串联

**Files:**
- Modify: `src/memory/strategy.ts`（追加 buildStrategy 工厂函数）
- Modify: `src/server/index.ts`（接收 MemoryStrategy 而非 SessionMemory）
- Modify: `src/server/routes/chat.ts`（接入 context 组装）
- Modify: `src/index.ts`（初始化 DB + buildStrategy + friday provider）

- [ ] **Step 1: 在 strategy.ts 追加工厂函数**

在 `src/memory/strategy.ts` 末尾追加：

```typescript
import type { Config } from "../config/schema.js"
import type { Db } from "../db/client.js"
import type { Provider } from "../providers/types.js"
import { BufferStrategy } from "./strategies/buffer.js"
import { LayeredStrategy } from "./strategies/layered.js"

const DEFAULT_SYSTEM_PROMPT = `你是 GeminiClaw，一个智能 AI 助手。回答简洁、准确、有帮助。`

export function buildStrategy(
  config: Config,
  db: Db,
  routerProvider: Provider | null,
): MemoryStrategy {
  if (config.memory.strategy === "layered" && routerProvider) {
    return new LayeredStrategy({
      db,
      routerProvider,
      triageProvider: routerProvider,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      recentMessageLimit: config.memory.recentMessageLimit,
      triageAfterTurns: config.memory.triageAfterTurns,
      compactThresholdBytes: config.memory.compactThresholdBytes,
      maxActiveTopics: config.memory.maxActiveTopics,
    })
  }
  return new BufferStrategy({ recentMessageLimit: config.memory.recentMessageLimit })
}
```

- [ ] **Step 2: 改造 chat.ts（接入 MemoryStrategy）**

完整替换 `src/server/routes/chat.ts`：

```typescript
// src/server/routes/chat.ts
import type { FastifyInstance } from "fastify"
import type { ProviderRouter } from "../../providers/router.js"
import type { MemoryStrategy } from "../../memory/strategy.js"

interface ChatBody {
  message: string
  sessionId?: string
  model?: string
  stream?: boolean
}

interface ChatRouteOpts {
  router: ProviderRouter
  strategy: MemoryStrategy
  authToken?: string
}

export async function chatRoute(
  fastify: FastifyInstance,
  opts: ChatRouteOpts,
): Promise<void> {
  fastify.post<{ Body: ChatBody }>("/v1/agent/chat", async (request, reply) => {
    if (opts.authToken) {
      const auth = request.headers["authorization"]
      if (!auth || auth !== `Bearer ${opts.authToken}`) {
        return reply.status(401).send({ error: "Unauthorized" })
      }
    }

    const { message, sessionId, model, stream: wantStream } = request.body
    const sid = sessionId ?? crypto.randomUUID()

    await opts.strategy.ensureSession(sid)

    // 1. 获取 context（含 system + 事项索引 + 历史）
    const { messages: contextMessages } = await opts.strategy.getContext(sid, message)

    // 2. 追加当前用户消息
    const allMessages = [...contextMessages, { role: "user" as const, content: message }]

    if (wantStream) {
      // SSE 流式
      reply.raw.setHeader("Content-Type", "text/event-stream")
      reply.raw.setHeader("Cache-Control", "no-cache")
      reply.raw.setHeader("Connection", "keep-alive")

      let fullContent = ""

      try {
        for await (const chunk of opts.router.stream(allMessages, model ? { model } : undefined)) {
          if (chunk.delta) {
            fullContent += chunk.delta
            const data = JSON.stringify({ choices: [{ delta: { content: chunk.delta } }] })
            reply.raw.write(`data: ${data}\n\n`)
          }
          if (chunk.done) {
            reply.raw.write(`data: ${JSON.stringify({ type: "done" })}\n\n`)
            reply.raw.write("data: [DONE]\n\n")
          }
        }
      } finally {
        reply.raw.end()
      }

      // 后台追加 + 异步处理
      if (fullContent) {
        await opts.strategy.appendTurn(
          sid,
          { role: "user", content: message },
          { role: "assistant", content: fullContent },
        )
      }

      return reply
    }

    // 非流式
    const chatResponse = await opts.router.chat(allMessages, model ? { model } : undefined)

    await opts.strategy.appendTurn(
      sid,
      { role: "user", content: message },
      { role: "assistant", content: chatResponse.content },
    )

    return reply.send({
      response: chatResponse.content,
      sessionId: sid,
      model: chatResponse.model,
    })
  })
}
```

- [ ] **Step 3: 改造 server/index.ts**

完整替换 `src/server/index.ts`：

```typescript
// src/server/index.ts
import Fastify, { type FastifyInstance } from "fastify"
import type { Config } from "../config/schema.js"
import type { ProviderRouter } from "../providers/router.js"
import type { MemoryStrategy } from "../memory/strategy.js"
import { healthRoute } from "./routes/health.js"
import { chatRoute } from "./routes/chat.js"

export async function buildServer(
  config: Config,
  router: ProviderRouter,
  strategy: MemoryStrategy,
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false })

  await fastify.register(healthRoute)
  await fastify.register(chatRoute, {
    router,
    strategy,
    authToken: config.server.authToken,
  })

  return fastify
}
```

- [ ] **Step 4: 改造 src/index.ts（完整串联）**

完整替换 `src/index.ts`：

```typescript
// src/index.ts
import { loadConfig } from "./config/loader.js"
import { AnthropicProvider } from "./providers/anthropic.js"
import { McliProvider } from "./providers/mcli.js"
import { FridayProvider } from "./providers/friday.js"
import { ProviderRouter } from "./providers/router.js"
import { buildStrategy } from "./memory/strategy.js"
import { buildServer } from "./server/index.js"
import { openDb } from "./db/client.js"
import { migrate } from "./db/schema.js"
import { join } from "path"
import type { Provider } from "./providers/types.js"
import type { ProviderConfig } from "./config/schema.js"

function buildProvider(config: ProviderConfig): Provider {
  switch (config.type) {
    case "anthropic":
      return new AnthropicProvider(config)
    case "mcli":
      return new McliProvider(config)
    case "friday":
      return new FridayProvider(config)
    default:
      throw new Error(`Unsupported provider type: ${config.type}`)
  }
}

async function main(): Promise<void> {
  const config = loadConfig()

  // Provider 初始化
  const providers = config.providers.map(buildProvider)
  const router = new ProviderRouter(providers, config.routing)

  // DB 初始化（layered 策略需要）
  const dbPath = join(config.memory.dataDir, "geminiclaw.db")
  const db = openDb(dbPath)
  migrate(db)

  // 路由 provider（friday，用于 layered 策略的摘要/路由）
  const routerProvider = providers.find(p => p.name === "friday") ?? null

  // 记忆策略
  const strategy = buildStrategy(config, db, routerProvider)

  const server = await buildServer(config, router, strategy)

  await server.listen({ port: config.server.port, host: config.server.host })
  console.log(`GeminiClaw listening on ${config.server.host}:${config.server.port}`)
  console.log(`Memory strategy: ${strategy.name}`)
}

main().catch(err => {
  console.error("Fatal error:", err)
  process.exit(1)
})
```

- [ ] **Step 5: 修复 chat.test.ts（适配新接口）**

`src/server/routes/chat.test.ts` 现在传的是 `SessionMemory`，需要改为传 `MemoryStrategy`。完整替换：

```typescript
// src/server/routes/chat.test.ts
import { it, expect, vi } from "vitest"
import { buildServer } from "../index.js"
import type { ProviderRouter } from "../../providers/router.js"
import type { MemoryStrategy, ConversationContext } from "../../memory/strategy.js"
import type { Config } from "../../config/schema.js"

function makeConfig(authToken?: string): Config {
  return {
    server: { port: 3000, host: "0.0.0.0", authToken },
    providers: [{ name: "p1", type: "anthropic", models: ["m1"] }],
    routing: { default: "p1/m1", fallback: ["p1/m1"] },
    memory: {
      enabled: true,
      dataDir: ".data",
      maxSessionAge: 3600,
      strategy: "buffer",
      maxActiveTopics: 16,
      compactThresholdBytes: 6144,
      recentMessageLimit: 20,
      triageAfterTurns: 3,
    },
    agent: { maxTurns: 10, timeoutSeconds: 30 },
  }
}

function makeRouter(): ProviderRouter {
  return {
    chat: vi.fn().mockResolvedValue({ content: "pong", model: "m1" }),
    stream: vi.fn(),
  } as unknown as ProviderRouter
}

function makeStrategy(): MemoryStrategy {
  const history: Array<{ role: string; content: string }> = []
  return {
    name: "buffer",
    ensureSession: vi.fn().mockResolvedValue(undefined),
    getContext: vi.fn().mockResolvedValue({ messages: history, strategyName: "buffer" } as ConversationContext),
    appendTurn: vi.fn().mockResolvedValue(undefined),
  } as unknown as MemoryStrategy
}

it("returns 401 when authToken is set and no header provided", async () => {
  const app = await buildServer(makeConfig("secret"), makeRouter(), makeStrategy())
  const res = await app.inject({ method: "POST", url: "/v1/agent/chat", payload: { message: "hi" } })
  expect(res.statusCode).toBe(401)
})

it("returns 401 when authToken is set and wrong token provided", async () => {
  const app = await buildServer(makeConfig("secret"), makeRouter(), makeStrategy())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    headers: { authorization: "Bearer wrong" },
    payload: { message: "hi" },
  })
  expect(res.statusCode).toBe(401)
})

it("returns response when no authToken configured", async () => {
  const router = makeRouter()
  const app = await buildServer(makeConfig(), router, makeStrategy())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "ping" },
  })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body)
  expect(body.response).toBe("pong")
  expect(body.sessionId).toBeDefined()
})

it("returns response when correct bearer token provided", async () => {
  const router = makeRouter()
  const app = await buildServer(makeConfig("secret"), router, makeStrategy())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    headers: { authorization: "Bearer secret" },
    payload: { message: "ping" },
  })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body)
  expect(body.response).toBe("pong")
})

it("passes sessionId from request to strategy", async () => {
  const strategy = makeStrategy()
  const app = await buildServer(makeConfig(), makeRouter(), strategy)
  await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "hi", sessionId: "my-session" },
  })
  expect(strategy.ensureSession).toHaveBeenCalledWith("my-session")
})
```

- [ ] **Step 6: 全量测试**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -20
```
Expected: all pass

- [ ] **Step 7: 构建验证**

```bash
cd ~/Codes/GeminiClaw && pnpm build 2>&1 | tail -10
```
Expected: exit 0，dist/ 生成

- [ ] **Step 8: commit**

```bash
cd ~/Codes/GeminiClaw && git add src/memory/strategy.ts src/server/index.ts src/server/routes/chat.ts src/server/routes/chat.test.ts src/index.ts
git commit -m "feat: wire MemoryStrategy into server + chat route (buffer/layered)"
```

---

## Task 11: config.example.yaml 更新 + 最终验证

**Files:**
- Modify: `config.example.yaml`

- [ ] **Step 1: 更新 config.example.yaml 加入 friday + layered 示例**

完整替换 `config.example.yaml`：

```yaml
server:
  port: 3000
  host: "0.0.0.0"
  # authToken: "your-secret-token"

providers:
  - name: mcli
    type: mcli
    apiKey: "your-mcli-api-key"
    baseUrl: "https://mcli.sankuai.com/v1"
    models:
      - claude-opus-4-6
      - claude-sonnet-4-6

  - name: friday
    type: friday
    apiKey: "your-friday-api-key"
    baseUrl: "https:///v1/openai/native"
    models:
      - gemini-3-flash-preview

routing:
  default: "mcli/claude-opus-4-6"
  fallback:
    - "mcli/claude-sonnet-4-6"
    - "friday/gemini-3-flash-preview"

memory:
  enabled: true
  dataDir: ".data"
  maxSessionAge: 86400

  # 记忆策略：
  #   buffer  = 滑动窗口（纯内存，重启丢失，适合开发/测试）
  #   layered = 分层 topics（SQLite 持久化，完整记忆系统，需要 friday provider）
  strategy: buffer

  maxActiveTopics: 16             # 最多保持活跃的事项数
  compactThresholdBytes: 6144     # 事项文档超过此大小触发摘要压缩（6KB）
  recentMessageLimit: 20          # 注入 context 的近期消息条数
  triageAfterTurns: 3             # 累计几轮后触发立项判断

agent:
  maxTurns: 20
  timeoutSeconds: 60
```

- [ ] **Step 2: 全量测试（最终）**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1
```
Expected: all suites green，无 skip，无 fail

- [ ] **Step 3: 构建（最终）**

```bash
cd ~/Codes/GeminiClaw && rm -rf dist && pnpm build 2>&1
```
Expected: exit 0

- [ ] **Step 4: commit**

```bash
cd ~/Codes/GeminiClaw && git add config.example.yaml
git commit -m "docs: update config.example.yaml with friday + layered memory"
```

- [ ] **Step 5: 打 tag**

```bash
cd ~/Codes/GeminiClaw && git tag v0.2.0 -m "feat: complete memory system (friday + buffer/layered strategies)"
```
