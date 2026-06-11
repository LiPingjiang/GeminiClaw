import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { migrate } from "../../src/db/schema.js"
import { MemoryManagerSession, renderExit } from "../../src/guidance/memory-manager.js"

describe("MemoryManagerSession", () => {
  let db: any
  beforeEach(() => {
    db = new Database(":memory:")
    migrate(db)
  })

  it("enter() creates an isolated session bound to the target agent", () => {
    const mm = new MemoryManagerSession(db)
    const s = mm.enter("user1", "agent-a1", "龙股助手")
    expect(s.sessionId).toMatch(/^mem-/) // 临时隔离 session 前缀
    expect(s.targetAgentId).toBe("agent-a1")
    expect(mm.isActive("user1")).toBe(true)
  })

  it("exit() ends the management session", () => {
    const mm = new MemoryManagerSession(db)
    mm.enter("user1", "agent-a1", "龙股助手")
    mm.exit("user1")
    expect(mm.isActive("user1")).toBe(false)
  })

  it("getActive() returns target agent + isolated session for active user", () => {
    const mm = new MemoryManagerSession(db)
    mm.enter("user1", "agent-a1", "龙股助手")
    const a = mm.getActive("user1")!
    expect(a.targetAgentId).toBe("agent-a1")
  })

  it("recentDialog() returns the target agent's last messages in chrono order", () => {
    const mm = new MemoryManagerSession(db)
    // wire an agent -> its chat session -> some messages
    db.prepare(`INSERT INTO chat_sessions (id) VALUES (?)`).run("sess-a1")
    db.prepare(
      `INSERT INTO agents (id, session_id, template_name, agent_name) VALUES (?, ?, ?, ?)`,
    ).run("agent-a1", "sess-a1", "tpl", "龙股助手")
    db.prepare(`INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)`).run("sess-a1", "user", "m1")
    db.prepare(`INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)`).run("sess-a1", "assistant", "r1")
    db.prepare(`INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)`).run("sess-a1", "user", "m2")
    db.prepare(`INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)`).run("sess-a1", "assistant", "r2")
    const recent = mm.recentDialog("agent-a1", 3)
    expect(recent.length).toBe(3)
    // chronological: oldest of the slice first, newest last
    expect(recent[recent.length - 1].content).toBe("r2")
    expect(recent[0].role).toBeDefined()
  })

  it("recentDialog() returns [] when the agent has no session/messages", () => {
    const mm = new MemoryManagerSession(db)
    expect(mm.recentDialog("nope", 5)).toEqual([])
  })

  it("renderExit() names the agent and previews recent dialog", () => {
    const out = renderExit("龙股助手", [
      { role: "user", content: "今天有什么信号" },
      { role: "assistant", content: "HK 三只命中" },
    ])
    expect(out).toContain("龙股助手")
    expect(out).toContain("今天有什么信号")
    expect(out).toContain("HK 三只命中")
  })

  it("renderExit() still works with empty recent dialog", () => {
    const out = renderExit("龙股助手", [])
    expect(out).toContain("龙股助手")
  })
})
