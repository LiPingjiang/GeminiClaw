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
  expect(docMsg.some(m => typeof m.content === "string" && m.content.includes("详细概览内容"))).toBe(true)
})

it("getContext loads lower-level doc when router returns low confidence (< 0.7)", async () => {
  const { LayeredStrategy } = await import("./layered.js")
  const db = makeDb()

  db.prepare(`
    INSERT INTO memory_topics (id, title, summary, doc_level2, active)
    VALUES (?, ?, ?, ?, 1)
  `).run("t1", "某事项", "摘要", "详细内容")

  // 低置信度 (0.3 < 0.7)：level 被 clamp 到 ≤ 2，但仍然加载文档
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

  // 低置信度时仍加载文档，但 level 被 clamp（不超过 level 2）
  const docMsgs = ctx.messages.filter(m => m.role === "system" && typeof m.content === "string" && m.content.includes("详细内容"))
  expect(docMsgs.length).toBeGreaterThanOrEqual(1)
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
