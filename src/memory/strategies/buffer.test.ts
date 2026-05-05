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
