import { it, expect, beforeEach } from "vitest"
import { BufferStrategy } from "./buffer.js"

let strategy: BufferStrategy

beforeEach(() => {
  strategy = new BufferStrategy({ recentMessageLimit: 4 })
})

it("getContext returns empty messages for unknown session", async () => {
  const ctx = await strategy.getContext("unknown", "hi")
  expect(ctx.messages).toEqual([])
})

it("appendTurn stores user and assistant messages", async () => {
  await strategy.appendTurn("s1", { role: "user", content: "hello" }, { role: "assistant", content: "hi" })
  const ctx = await strategy.getContext("s1", "next")
  expect(ctx.messages).toHaveLength(2)
  expect(ctx.messages[0].role).toBe("user")
  expect(ctx.messages[1].role).toBe("assistant")
})

it("respects recentMessageLimit", async () => {
  for (let i = 0; i < 6; i++) {
    await strategy.appendTurn(
      "s1",
      { role: "user", content: `msg ${i}` },
      { role: "assistant", content: `reply ${i}` }
    )
  }
  const ctx = await strategy.getContext("s1", "next")
  // limit=4 means last 4 messages (2 turns)
  expect(ctx.messages).toHaveLength(4)
  expect(ctx.messages[0].content).toBe("msg 4")
})

it("ensureSession is idempotent", async () => {
  await strategy.ensureSession("s1")
  await strategy.ensureSession("s1")
  const ctx = await strategy.getContext("s1", "hi")
  expect(ctx.messages).toEqual([])
})

it("handles limit=1 (only last message kept)", async () => {
  const strategy = new BufferStrategy({ recentMessageLimit: 1 })
  await strategy.appendTurn(
    "s1",
    { role: "user", content: "first" },
    { role: "assistant", content: "first reply" },
  )
  await strategy.appendTurn(
    "s1",
    { role: "user", content: "second" },
    { role: "assistant", content: "second reply" },
  )
  const ctx = await strategy.getContext("s1", "next")
  expect(ctx.messages).toHaveLength(1)
  expect(ctx.messages[0].content).toBe("second reply")
})

it("multiple sessions are isolated", async () => {
  const strategy = new BufferStrategy({ recentMessageLimit: 20 })
  await strategy.appendTurn(
    "sA",
    { role: "user", content: "session A" },
    { role: "assistant", content: "reply A" },
  )
  await strategy.appendTurn(
    "sB",
    { role: "user", content: "session B" },
    { role: "assistant", content: "reply B" },
  )
  const ctxA = await strategy.getContext("sA", "next")
  const ctxB = await strategy.getContext("sB", "next")

  expect(ctxA.messages.some(m => typeof m.content === "string" && m.content.includes("session B"))).toBe(false)
  expect(ctxB.messages.some(m => typeof m.content === "string" && m.content.includes("session A"))).toBe(false)
})
