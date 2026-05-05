import { it, expect, vi } from "vitest"
import type { Provider } from "../providers/types.js"

function makeProvider(responseText: string): Provider {
  return {
    name: "friday",
    chat: vi.fn().mockResolvedValue({ content: responseText, model: "gemini-flash" }),
    stream: vi.fn(),
  } as unknown as Provider
}

it("returns skip when turns below threshold", async () => {
  const { TriageService } = await import("./triage.js")
  const svc = new TriageService(makeProvider("{}"), { triageAfterTurns: 3 })

  // 只有 2 轮（4 条消息），不触发
  const msgs = [
    { role: "user" as const, content: "hi" },
    { role: "assistant" as const, content: "hello" },
    { role: "user" as const, content: "how are you" },
    { role: "assistant" as const, content: "fine" },
  ]
  const result = await svc.triage("s1", msgs, [])
  expect(result.action).toBe("skip")
})

it("returns new_topic when model suggests creating", async () => {
  const { TriageService } = await import("./triage.js")
  const responseJson = JSON.stringify({
    action: "new_topic",
    title: "GeminiClaw 记忆系统设计",
    summary: "讨论了分层记忆架构和 SQLite 存储方案",
  })
  const svc = new TriageService(makeProvider(responseJson), { triageAfterTurns: 2 })

  const msgs = Array.from({ length: 4 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `msg ${i}`,
  }))
  const result = await svc.triage("s1", msgs, [])
  expect(result.action).toBe("new_topic")
  if (result.action === "new_topic") {
    expect(result.title).toBe("GeminiClaw 记忆系统设计")
    expect(result.summary).toBe("讨论了分层记忆架构和 SQLite 存储方案")
  }
})

it("returns merge_topic when model suggests merging", async () => {
  const { TriageService } = await import("./triage.js")
  const responseJson = JSON.stringify({ action: "merge_topic", topicId: "topic_001" })
  const svc = new TriageService(makeProvider(responseJson), { triageAfterTurns: 2 })

  const msgs = Array.from({ length: 4 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `msg ${i}`,
  }))
  const topics = [{ id: "topic_001", title: "GeminiClaw 开发", summary: "已有事项" }]
  const result = await svc.triage("s1", msgs, topics)
  expect(result.action).toBe("merge_topic")
  if (result.action === "merge_topic") {
    expect(result.topicId).toBe("topic_001")
  }
})

it("returns skip on malformed JSON from model", async () => {
  const { TriageService } = await import("./triage.js")
  const svc = new TriageService(makeProvider("not json"), { triageAfterTurns: 2 })
  const msgs = Array.from({ length: 4 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `msg ${i}`,
  }))
  const result = await svc.triage("s1", msgs, [])
  expect(result.action).toBe("skip")
})
