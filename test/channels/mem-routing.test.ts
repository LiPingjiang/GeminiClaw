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
  it("detects natural-language return/back as exit", () => {
    expect(resolveMemIntent("/back")?.action).toBe("exit")
    expect(resolveMemIntent("/q")?.action).toBe("exit")
    expect(resolveMemIntent("返回")?.action).toBe("exit")
    expect(resolveMemIntent("回去")?.action).toBe("exit")
    expect(resolveMemIntent("切回助手")?.action).toBe("exit")
    expect(resolveMemIntent("回到对话")?.action).toBe("exit")
    expect(resolveMemIntent("不整理了")?.action).toBe("exit")
  })
  it("does not treat normal chat as exit", () => {
    expect(resolveMemIntent("帮我回顾下昨天的信号")).toBeNull()
    expect(resolveMemIntent("返回结果是什么意思")).toBeNull()
  })
  it("returns null for normal chat", () => {
    expect(resolveMemIntent("今天龙股有什么信号")).toBeNull()
  })
})
