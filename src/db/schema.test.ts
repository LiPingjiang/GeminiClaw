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
  expect(names).toContain("public_knowledge")
  expect(names).toContain("agent_memory")
  db.close()
})

it("creates memory_topics compat VIEW on migrate", () => {
  const db = openDb(TEST_DB)
  migrate(db)

  const views = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='view' ORDER BY name`
  ).all() as Array<{ name: string }>

  expect(views.map(v => v.name)).toContain("memory_topics")
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

it("can insert and query public_knowledge", () => {
  const db = openDb(TEST_DB)
  migrate(db)

  db.prepare(`
    INSERT INTO public_knowledge (id, title, summary, active)
    VALUES (?, ?, ?, ?)
  `).run("topic_001", "GeminiClaw 开发进度", "正在构建记忆系统", 1)

  const topic = db.prepare(`SELECT * FROM public_knowledge WHERE id = ?`).get("topic_001") as { title: string; active: number }
  expect(topic.title).toBe("GeminiClaw 开发进度")
  expect(topic.active).toBe(1)
  db.close()
})

it("memory_topics VIEW reads from public_knowledge", () => {
  const db = openDb(TEST_DB)
  migrate(db)

  db.prepare(`
    INSERT INTO public_knowledge (id, title, summary, active)
    VALUES (?, ?, ?, ?)
  `).run("topic_002", "兼容性测试", "通过 VIEW 读取", 1)

  // Legacy code using memory_topics should still work via the compat VIEW
  const topic = db.prepare(`SELECT * FROM memory_topics WHERE id = ?`).get("topic_002") as { title: string }
  expect(topic.title).toBe("兼容性测试")
  db.close()
})

it("agent_memory table has correct default values", () => {
  const db = openDb(TEST_DB)
  migrate(db)

  // Need a parent agents row first (FK constraint)
  db.prepare(`INSERT INTO chat_sessions (id) VALUES (?)`).run("sess-1")
  db.prepare(`
    INSERT INTO agents (id, session_id, template_name, agent_name)
    VALUES (?, ?, ?, ?)
  `).run("agent-001", "sess-1", "base", "测试助手")

  db.prepare(`INSERT INTO agent_memory (agent_id) VALUES (?)`).run("agent-001")

  const row = db.prepare(`SELECT * FROM agent_memory WHERE agent_id = ?`).get("agent-001") as {
    has_agent_md: number
    has_memory_md: number
    has_daily: number
    cold_start_done: number
  }
  expect(row.has_agent_md).toBe(0)
  expect(row.has_memory_md).toBe(0)
  expect(row.has_daily).toBe(0)
  expect(row.cold_start_done).toBe(0)
  db.close()
})

it("agent_memory cascades on agent delete", () => {
  const db = openDb(TEST_DB)
  migrate(db)

  db.prepare(`INSERT INTO chat_sessions (id) VALUES (?)`).run("sess-2")
  db.prepare(`
    INSERT INTO agents (id, session_id, template_name, agent_name)
    VALUES (?, ?, ?, ?)
  `).run("agent-002", "sess-2", "base", "删除测试")
  db.prepare(`INSERT INTO agent_memory (agent_id) VALUES (?)`).run("agent-002")

  // Deleting the agent should cascade-delete the agent_memory row
  db.prepare(`DELETE FROM agents WHERE id = ?`).run("agent-002")

  const row = db.prepare(`SELECT * FROM agent_memory WHERE agent_id = ?`).get("agent-002")
  expect(row).toBeUndefined()
  db.close()
})
