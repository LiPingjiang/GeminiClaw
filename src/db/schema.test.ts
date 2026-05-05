import { it, expect, afterEach } from "vitest"
import { existsSync, rmSync } from "fs"
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
