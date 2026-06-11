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

  db.prepare(`INSERT INTO public_knowledge (id, title, summary) VALUES (?, ?, ?)`).run("t1", "测试事项", "初始摘要")
  await svc.appendToTopic("t1", "新增内容")

  const topic = db.prepare(`SELECT * FROM public_knowledge WHERE id = ?`).get("t1") as { doc_level2: string }
  expect(topic.doc_level2).toContain("新增内容")
})

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
      INSERT INTO public_knowledge (id, title, summary, active, last_accessed_at, access_count)
      VALUES (?, ?, ?, 1, datetime('now', ?), ?)
    `).run(`t${i}`, `事项${i}`, `摘要${i}`, `-${i * 10} minutes`, i)
  }

  await svc.evictIfNeeded()

  const active = db.prepare(`SELECT id FROM public_knowledge WHERE active = 1`).all() as Array<{ id: string }>
  expect(active).toHaveLength(2)
  // t1 是最老的（-10 分钟，最低 access_count=1），应该被清理
  expect(active.map(t => t.id)).not.toContain("t1")
})
