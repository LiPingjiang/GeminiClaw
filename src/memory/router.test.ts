import { it, expect, vi, beforeEach } from "vitest"
import type { Provider } from "../providers/types.js"

function makeProvider(responseText: string): Provider {
  return {
    name: "friday",
    chat: vi.fn().mockResolvedValue({ content: responseText, model: "gemini-flash" }),
    stream: vi.fn(),
  } as unknown as Provider
}

it("returns empty match when no topics", async () => {
  const { TopicRouter } = await import("./router.js")
  const router = new TopicRouter(makeProvider("{}"))
  const result = await router.route("hello", [], [])
  expect(result.matches).toEqual([])
  expect(result.confidence).toBe(0)
})

it("parses valid JSON response from model", async () => {
  const { TopicRouter } = await import("./router.js")
  const responseJson = JSON.stringify({
    matches: [{ topicId: "topic_001", confidence: 0.85, level: 2 }],
    confidence: 0.85,
  })
  const router = new TopicRouter(makeProvider(responseJson))

  const topics = [{ id: "topic_001", title: "GeminiClaw 开发", summary: "构建记忆系统" }]
  const result = await router.route("记忆系统进展怎么样了", [], topics)

  expect(result.matches).toHaveLength(1)
  expect(result.matches[0].topicId).toBe("topic_001")
  expect(result.matches[0].confidence).toBeCloseTo(0.85)
  expect(result.confidence).toBeCloseTo(0.85)
})

it("returns empty match on malformed JSON", async () => {
  const { TopicRouter } = await import("./router.js")
  const router = new TopicRouter(makeProvider("not json at all"))
  const topics = [{ id: "topic_001", title: "test", summary: "test" }]
  const result = await router.route("hi", [], topics)
  expect(result.matches).toEqual([])
  expect(result.confidence).toBe(0)
})
