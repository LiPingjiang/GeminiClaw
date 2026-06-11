import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { migrate } from "../../src/db/schema.js"
import { MemoryManagerSession } from "../../src/guidance/memory-manager.js"

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
})
