import { describe, it, expect } from "vitest"
import { resolveMemIntent } from "../../src/guidance/mem-intent.js"

describe("resolveMemIntent", () => {
  it("detects /mem command", () => {
    expect(resolveMemIntent("/mem")?.action).toBe("enter")
  })
  it("detects natural language enter", () => {
    expect(resolveMemIntent("帮我整理一下当前助手的记忆")?.action).toBe("enter")
    expect(resolveMemIntent("梳理工作记忆")?.action).toBe("enter")
  })
  it("detects exit", () => {
    expect(resolveMemIntent("/exit")?.action).toBe("exit")
    expect(resolveMemIntent("退出记忆管理")?.action).toBe("exit")
  })
  it("returns null for normal chat", () => {
    expect(resolveMemIntent("今天龙股有什么信号")).toBeNull()
  })
})
