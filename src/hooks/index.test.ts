import { describe, it, expect, vi, beforeEach } from "vitest"
import { HookBus } from "./index.js"
import type {
  PreToolCallPayload,
  PostToolCallPayload,
  PreLlmCallPayload,
  PostLlmCallPayload,
  SessionStartPayload,
  SessionEndPayload,
} from "./index.js"

describe("HookBus", () => {
  let bus: HookBus

  beforeEach(() => {
    bus = new HookBus()
  })

  // ── Basic registration & emit ──────────────────────────────────────────────

  describe("on() and emit()", () => {
    it("calls registered handler on exact event match", async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      bus.on("pre_tool_call", handler)

      const payload: PreToolCallPayload = {
        toolCallId: "tc1",
        toolName: "exec",
        args: { command: "ls" },
        sessionId: "s1",
      }
      await bus.emit("pre_tool_call", payload)

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith(payload)
    })

    it("does not call handler for non-matching event", async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      bus.on("pre_tool_call", handler)

      await bus.emit("post_tool_call", {
        toolCallId: "tc1",
        toolName: "exec",
        args: {},
        result: { content: "ok", isError: false },
        durationMs: 10,
        sessionId: "s1",
      })

      expect(handler).not.toHaveBeenCalled()
    })

    it("supports multiple handlers on the same event", async () => {
      const h1 = vi.fn().mockResolvedValue("a")
      const h2 = vi.fn().mockResolvedValue("b")
      bus.on("on_session_start", h1)
      bus.on("on_session_start", h2)

      await bus.emit("on_session_start", { sessionId: "s1", timestamp: 1 })

      expect(h1).toHaveBeenCalledOnce()
      expect(h2).toHaveBeenCalledOnce()
    })

    it("handler errors are caught and do not propagate", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      const badHandler = vi.fn().mockRejectedValue(new Error("boom"))
      const goodHandler = vi.fn().mockResolvedValue("ok")

      bus.on("pre_llm_call", badHandler)
      bus.on("pre_llm_call", goodHandler)

      // Should not throw
      await bus.emit("pre_llm_call", {
        messageCount: 5,
        sessionId: "s1",
      })

      expect(goodHandler).toHaveBeenCalledOnce()
      expect(errSpy).toHaveBeenCalled()
      errSpy.mockRestore()
    })
  })

  // ── Glob matching ──────────────────────────────────────────────────────────

  describe("glob patterns", () => {
    it("matches 'pre_*' pattern for all pre_ events", async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      bus.on("pre_*" as any, handler)

      await bus.emit("pre_tool_call", {
        toolCallId: "tc1",
        toolName: "exec",
        args: {},
        sessionId: "s1",
      })
      await bus.emit("pre_llm_call", {
        messageCount: 3,
        sessionId: "s1",
      })

      expect(handler).toHaveBeenCalledTimes(2)
    })

    it("matches '*_call' pattern for all call events", async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      bus.on("*_call" as any, handler)

      await bus.emit("pre_tool_call", {
        toolCallId: "tc1",
        toolName: "exec",
        args: {},
        sessionId: "s1",
      })
      await bus.emit("pre_llm_call", {
        messageCount: 3,
        sessionId: "s1",
      })

      expect(handler).toHaveBeenCalledTimes(2)
    })

    it("matches '*' wildcard for ALL events", async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      bus.on("*" as any, handler)

      await bus.emit("pre_tool_call", {
        toolCallId: "tc1",
        toolName: "exec",
        args: {},
        sessionId: "s1",
      })
      await bus.emit("on_session_start", { sessionId: "s1", timestamp: 1 })
      await bus.emit("on_session_end", {
        sessionId: "s1",
        totalTurns: 5,
        stopReason: "done",
        timestamp: 2,
      })

      expect(handler).toHaveBeenCalledTimes(3)
    })

    it("matches 'on_session_*' for session events only", async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      bus.on("on_session_*" as any, handler)

      await bus.emit("on_session_start", { sessionId: "s1", timestamp: 1 })
      await bus.emit("on_session_end", {
        sessionId: "s1",
        totalTurns: 5,
        stopReason: "done",
        timestamp: 2,
      })
      await bus.emit("pre_tool_call", {
        toolCallId: "tc1",
        toolName: "exec",
        args: {},
        sessionId: "s1",
      })

      expect(handler).toHaveBeenCalledTimes(2)
    })
  })

  // ── Priority ───────────────────────────────────────────────────────────────

  describe("priority ordering", () => {
    it("runs lower-priority handlers first in emitCollect", async () => {
      const order: number[] = []
      bus.on(
        "pre_tool_call",
        async () => { order.push(1) },
        10,
      )
      bus.on(
        "pre_tool_call",
        async () => { order.push(2) },
        50,
      )
      bus.on(
        "pre_tool_call",
        async () => { order.push(3) },
        200,
      )

      await bus.emitCollect("pre_tool_call", {
        toolCallId: "tc1",
        toolName: "exec",
        args: {},
        sessionId: "s1",
      })

      expect(order).toEqual([1, 2, 3])
    })
  })

  // ── emitCollect ────────────────────────────────────────────────────────────

  describe("emitCollect()", () => {
    it("returns collected values from handlers", async () => {
      bus.on("pre_tool_call", async () => ({ block: false }))
      bus.on("pre_tool_call", async () => ({ block: true, reason: "dangerous" }))

      const results = await bus.emitCollect("pre_tool_call", {
        toolCallId: "tc1",
        toolName: "rm",
        args: { path: "/" },
        sessionId: "s1",
      })

      expect(results).toEqual([
        { block: false },
        { block: true, reason: "dangerous" },
      ])
    })

    it("returns empty array when no handlers match", async () => {
      const results = await bus.emitCollect("on_session_start", {
        sessionId: "s1",
        timestamp: 1,
      })
      expect(results).toEqual([])
    })

    it("catches errors and puts undefined in results", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      bus.on("pre_tool_call", async () => { throw new Error("fail") })
      bus.on("pre_tool_call", async () => "ok")

      const results = await bus.emitCollect("pre_tool_call", {
        toolCallId: "tc1",
        toolName: "exec",
        args: {},
        sessionId: "s1",
      })

      expect(results).toEqual([undefined, "ok"])
      errSpy.mockRestore()
    })
  })

  // ── Unsubscribe ────────────────────────────────────────────────────────────

  describe("unsubscribe", () => {
    it("on() returns unsubscribe function that removes the handler", async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      const unsub = bus.on("pre_tool_call", handler)

      await bus.emit("pre_tool_call", {
        toolCallId: "tc1",
        toolName: "exec",
        args: {},
        sessionId: "s1",
      })
      expect(handler).toHaveBeenCalledOnce()

      unsub()

      await bus.emit("pre_tool_call", {
        toolCallId: "tc2",
        toolName: "exec",
        args: {},
        sessionId: "s1",
      })
      // Still 1 call, not 2
      expect(handler).toHaveBeenCalledOnce()
    })
  })

  // ── clear() ────────────────────────────────────────────────────────────────

  describe("clear()", () => {
    it("removes all handlers", async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      bus.on("pre_tool_call", handler)
      bus.on("post_tool_call", handler)

      expect(bus.size).toBe(2)
      bus.clear()
      expect(bus.size).toBe(0)

      await bus.emit("pre_tool_call", {
        toolCallId: "tc1",
        toolName: "exec",
        args: {},
        sessionId: "s1",
      })
      expect(handler).not.toHaveBeenCalled()
    })
  })

  // ── Diagnostics ────────────────────────────────────────────────────────────

  describe("diagnostics", () => {
    it("size reflects handler count", () => {
      expect(bus.size).toBe(0)
      bus.on("pre_tool_call", async () => {})
      bus.on("post_tool_call", async () => {})
      expect(bus.size).toBe(2)
    })

    it("listPatterns() returns human-readable list", () => {
      bus.on("pre_tool_call", async () => {}, 10)
      bus.on("post_*" as any, async () => {}, 200)

      const patterns = bus.listPatterns()
      expect(patterns).toContain("pre_tool_call (priority=10)")
      expect(patterns).toContain("post_* (priority=200)")
    })
  })
})
