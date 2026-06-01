/**
 * Tests for RunStore and Runs Route.
 *
 * Tests RunStore as a unit (state machine, events, cleanup).
 * Tests the route handlers via Fastify inject.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { RunStore } from "./run-store.js"

// ── RunStore Unit Tests ──────────────────────────────────────────────────────

describe("RunStore", () => {
  let store: RunStore

  beforeEach(() => {
    store = new RunStore({ maxCompleted: 5, completedTtlMs: 1000 })
  })

  afterEach(() => {
    store.destroy()
  })

  describe("lifecycle", () => {
    it("creates a run with pending status", () => {
      const id = store.create("sess-1")
      const run = store.get(id)
      expect(run).toBeDefined()
      expect(run!.status).toBe("pending")
      expect(run!.sessionId).toBe("sess-1")
      expect(run!.id).toMatch(/^run_/)
    })

    it("transitions pending → running", () => {
      const id = store.create("s1")
      store.setRunning(id)
      expect(store.get(id)!.status).toBe("running")
    })

    it("transitions running → completed", () => {
      const id = store.create("s1")
      store.setRunning(id)
      store.complete(id, "Hello world")
      const run = store.get(id)!
      expect(run.status).toBe("completed")
      expect(run.result).toBe("Hello world")
    })

    it("transitions running → failed", () => {
      const id = store.create("s1")
      store.setRunning(id)
      store.fail(id, "LLM timeout")
      const run = store.get(id)!
      expect(run.status).toBe("failed")
      expect(run.error).toBe("LLM timeout")
    })

    it("cancel returns true for pending/running runs", () => {
      const id = store.create("s1")
      expect(store.cancel(id)).toBe(true)
      expect(store.get(id)!.status).toBe("cancelled")
    })

    it("cancel returns false for completed runs", () => {
      const id = store.create("s1")
      store.setRunning(id)
      store.complete(id, "done")
      expect(store.cancel(id)).toBe(false)
    })

    it("setRunning is a no-op if not pending", () => {
      const id = store.create("s1")
      store.setRunning(id)
      store.complete(id, "done")
      store.setRunning(id) // no-op
      expect(store.get(id)!.status).toBe("completed")
    })
  })

  describe("delta accumulation", () => {
    it("appendDelta accumulates result content", () => {
      const id = store.create("s1")
      store.setRunning(id)
      store.appendDelta(id, "Hello ")
      store.appendDelta(id, "world")
      expect(store.get(id)!.result).toBe("Hello world")
    })

    it("appendDelta is a no-op when not running", () => {
      const id = store.create("s1")
      store.appendDelta(id, "nope")
      expect(store.get(id)!.result).toBeUndefined()
    })
  })

  describe("event emission", () => {
    it("subscribe receives real-time events", () => {
      const id = store.create("s1")
      const events: Array<{ type: string }> = []
      store.subscribe(id, (e) => events.push({ type: e.type }))

      store.setRunning(id)
      store.appendDelta(id, "hi")
      store.complete(id)

      expect(events.map((e) => e.type)).toEqual([
        "status_change",
        "message_delta",
        "done",
      ])
    })

    it("unsubscribe stops receiving events", () => {
      const id = store.create("s1")
      const events: string[] = []
      const unsub = store.subscribe(id, (e) => events.push(e.type))

      store.setRunning(id)
      unsub()
      store.appendDelta(id, "ignored")

      expect(events).toEqual(["status_change"])
    })

    it("events are accumulated on the run object", () => {
      const id = store.create("s1")
      store.setRunning(id)
      store.appendDelta(id, "hi")
      store.appendToolCall(id, "read_file", { path: "/foo" })
      store.appendToolResult(id, "read_file", "content")
      store.complete(id)

      const run = store.get(id)!
      expect(run.events).toHaveLength(5) // status_change + delta + tool_call + tool_result + done
      expect(run.events[0].type).toBe("status_change")
      expect(run.events[1].type).toBe("message_delta")
      expect(run.events[2].type).toBe("tool_call")
      expect(run.events[3].type).toBe("tool_result")
      expect(run.events[4].type).toBe("done")
    })
  })

  describe("tool events", () => {
    it("appendToolCall records tool invocation", () => {
      const id = store.create("s1")
      store.setRunning(id)
      store.appendToolCall(id, "grep", { pattern: "foo" })
      const event = store.get(id)!.events.find((e) => e.type === "tool_call")
      expect(event).toBeDefined()
      expect((event!.data as any).tool).toBe("grep")
    })

    it("appendToolResult records tool output", () => {
      const id = store.create("s1")
      store.setRunning(id)
      store.appendToolResult(id, "grep", "matched 3 files")
      const event = store.get(id)!.events.find((e) => e.type === "tool_result")
      expect(event).toBeDefined()
      expect((event!.data as any).result).toBe("matched 3 files")
    })
  })

  describe("getActive", () => {
    it("returns only pending/running runs", () => {
      const id1 = store.create("s1")
      const id2 = store.create("s2")
      store.setRunning(id1)
      store.complete(id1, "done")

      const active = store.getActive()
      expect(active).toHaveLength(1)
      expect(active[0].id).toBe(id2)
    })
  })

  describe("get returns undefined for unknown IDs", () => {
    it("returns undefined", () => {
      expect(store.get("nonexistent")).toBeUndefined()
    })
  })

  describe("size tracking", () => {
    it("tracks total runs", () => {
      store.create("s1")
      store.create("s2")
      expect(store.size).toBe(2)
    })
  })
})
