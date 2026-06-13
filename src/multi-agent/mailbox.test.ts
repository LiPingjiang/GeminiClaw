import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  sendTask,
  reportResult,
  onTaskResult,
  getMessage,
  markExecuting,
  getPendingForAgent,
  __resetMailbox,
} from "./mailbox.js"

describe("Agent Mailbox", () => {
  beforeEach(() => {
    __resetMailbox()
  })

  it("sendTask creates a pending message with unique ID", () => {
    const msg = sendTask({
      from: "agent-A",
      to: "translator",
      task: "翻译这段话",
      context: "Hello world",
    })
    expect(msg.id).toBeTruthy()
    expect(msg.id).toMatch(/^msg_/)
    expect(msg.from).toBe("agent-A")
    expect(msg.to).toBe("translator")
    expect(msg.task).toBe("翻译这段话")
    expect(msg.context).toBe("Hello world")
    expect(msg.status).toBe("pending")
    expect(msg.createdAt).toBeGreaterThan(0)
  })

  it("getMessage retrieves by ID", () => {
    const msg = sendTask({ from: "a", to: "b", task: "test" })
    expect(getMessage(msg.id)).toBe(msg)
    expect(getMessage("nonexistent")).toBeUndefined()
  })

  it("markExecuting changes status", () => {
    const msg = sendTask({ from: "a", to: "b", task: "test" })
    expect(msg.status).toBe("pending")
    markExecuting(msg.id)
    expect(getMessage(msg.id)!.status).toBe("executing")
  })

  it("reportResult marks message as completed and notifies sender", () => {
    const handler = vi.fn()
    onTaskResult("agent-A", handler)

    const msg = sendTask({
      from: "agent-A",
      to: "translator",
      task: "翻译 hello",
    })

    reportResult(msg.id, {
      success: true,
      output: "你好",
      durationMs: 100,
    })

    expect(getMessage(msg.id)!.status).toBe("completed")
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: msg.id,
        from: "translator",
        success: true,
        output: "你好",
        durationMs: 100,
      }),
    )
  })

  it("reportResult marks message as failed on failure", () => {
    const msg = sendTask({ from: "a", to: "b", task: "test" })
    reportResult(msg.id, { success: false, output: "error occurred" })
    expect(getMessage(msg.id)!.status).toBe("failed")
  })

  it("onTaskResult returns unsubscribe function", () => {
    const handler = vi.fn()
    const unsub = onTaskResult("agent-A", handler)

    const msg = sendTask({ from: "agent-A", to: "b", task: "test" })
    unsub()
    reportResult(msg.id, { success: true, output: "done" })

    expect(handler).not.toHaveBeenCalled()
  })

  it("getPendingForAgent returns only pending messages for target", () => {
    sendTask({ from: "a", to: "translator", task: "task1" })
    sendTask({ from: "a", to: "translator", task: "task2" })
    sendTask({ from: "a", to: "researcher", task: "task3" })

    const pending = getPendingForAgent("translator")
    expect(pending).toHaveLength(2)
    expect(pending[0].task).toBe("task1")
    expect(pending[1].task).toBe("task2")
  })

  it("getPendingForAgent excludes non-pending messages", () => {
    const msg = sendTask({ from: "a", to: "translator", task: "task1" })
    markExecuting(msg.id)
    sendTask({ from: "a", to: "translator", task: "task2" })

    const pending = getPendingForAgent("translator")
    expect(pending).toHaveLength(1)
    expect(pending[0].task).toBe("task2")
  })

  it("reportResult for unknown messageId logs warning but doesn't throw", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    reportResult("nonexistent", { success: true, output: "x" })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown messageId"),
    )
    warnSpy.mockRestore()
  })

  it("handler errors are caught and don't break other handlers", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const badHandler = vi.fn(() => { throw new Error("boom") })
    const goodHandler = vi.fn()

    onTaskResult("agent-A", badHandler)
    onTaskResult("agent-A", goodHandler)

    const msg = sendTask({ from: "agent-A", to: "b", task: "test" })
    reportResult(msg.id, { success: true, output: "done" })

    expect(badHandler).toHaveBeenCalled()
    expect(goodHandler).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
