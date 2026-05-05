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
