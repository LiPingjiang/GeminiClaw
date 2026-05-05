// src/memory/context.test.ts
import { it, expect } from "vitest"
import type { Message } from "../providers/types.js"

it("returns only recent messages when no topics", async () => {
  const { buildContext } = await import("./context.js")
  const history: Message[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ]
  const ctx = buildContext({
    systemPrompt: "You are helpful.",
    activeTopics: [],
    topicDocs: [],
    recentHistory: history,
    userMessage: "how are you",
    recentMessageLimit: 20,
  })
  // system + history
  expect(ctx[0].role).toBe("system")
  expect(ctx[0].content).toContain("You are helpful.")
  expect(ctx.slice(1)).toEqual(history)
})

it("injects active topic index into system prompt", async () => {
  const { buildContext } = await import("./context.js")
  const topics = [
    { id: "t1", title: "GeminiClaw 开发", summary: "构建记忆系统" },
    { id: "t2", title: "Spark 调优", summary: "分析 shuffle 瓶颈" },
  ]
  const ctx = buildContext({
    systemPrompt: "You are helpful.",
    activeTopics: topics,
    topicDocs: [],
    recentHistory: [],
    userMessage: "hi",
    recentMessageLimit: 20,
  })
  expect(ctx[0].role).toBe("system")
  expect(ctx[0].content).toContain("GeminiClaw 开发")
  expect(ctx[0].content).toContain("Spark 调优")
})

it("appends topic docs as system messages", async () => {
  const { buildContext } = await import("./context.js")
  const docs = [
    { topicId: "t1", title: "GeminiClaw 开发", level: 2 as const, content: "详细概览内容" },
  ]
  const ctx = buildContext({
    systemPrompt: "You are helpful.",
    activeTopics: [{ id: "t1", title: "GeminiClaw 开发", summary: "构建记忆系统" }],
    topicDocs: docs,
    recentHistory: [],
    userMessage: "hi",
    recentMessageLimit: 20,
  })
  const systemMsgs = ctx.filter(m => m.role === "system")
  expect(systemMsgs.some(m => m.content.includes("详细概览内容"))).toBe(true)
})

it("trims history to recentMessageLimit", async () => {
  const { buildContext } = await import("./context.js")
  const history: Message[] = Array.from({ length: 30 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `msg ${i}`,
  }))
  const ctx = buildContext({
    systemPrompt: "",
    activeTopics: [],
    topicDocs: [],
    recentHistory: history,
    userMessage: "hi",
    recentMessageLimit: 10,
  })
  const nonSystem = ctx.filter(m => m.role !== "system")
  expect(nonSystem).toHaveLength(10)
  expect(nonSystem[0].content).toBe("msg 20")
})
