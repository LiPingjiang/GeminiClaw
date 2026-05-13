// src/server/routes/chat.test.ts
import { it, describe, expect, vi, beforeEach } from "vitest"
import Fastify from "fastify"
import { buildServer } from "../index.js"
import { chatRoute } from "./chat.js"
import type { ProviderRouter } from "../../providers/router.js"
import type { MemoryStrategy, ConversationContext } from "../../memory/strategy.js"
import type { Config } from "../../config/schema.js"
import type { AgentLoop, AgentEvent } from "../../agent/index.js"

function makeConfig(authToken?: string): Config {
  return {
    server: { port: 3000, host: "0.0.0.0", authToken },
    providers: [{ name: "p1", type: "anthropic", models: ["m1"] }],
    routing: { default: "p1/m1", fallback: ["p1/m1"] },
    memory: {
      enabled: true,
      dataDir: ".data",
      maxSessionAge: 3600,
      strategy: "buffer",
      maxActiveTopics: 16,
      compactThresholdBytes: 6144,
      recentMessageLimit: 20,
      triageAfterTurns: 3,
    },
    agent: { maxTurns: 10, timeoutSeconds: 30 },
    workspace: { dir: ".workspace" },
    skills: { dir: "skills" },
  }
}

function makeRouter(): ProviderRouter {
  return {
    chat: vi.fn().mockResolvedValue({ content: "pong", model: "m1" }),
    stream: vi.fn(),
  } as unknown as ProviderRouter
}

function makeStrategy(): MemoryStrategy {
  const history: Array<{ role: string; content: string }> = []
  return {
    name: "buffer",
    ensureSession: vi.fn().mockResolvedValue(undefined),
    getContext: vi.fn().mockResolvedValue({ messages: history, strategyName: "buffer" } as ConversationContext),
    appendTurn: vi.fn().mockResolvedValue(undefined),
  } as unknown as MemoryStrategy
}

// Helper: make a mock AgentLoop from a sequence of events
function makeAgentLoop(events: AgentEvent[]): AgentLoop {
  return {
    run: vi.fn().mockImplementation(async function* () {
      for (const event of events) yield event
    }),
  } as unknown as AgentLoop
}

// Helper: build a minimal Fastify app with chatRoute + mocked agentLoop
async function buildChatApp(opts: {
  agentLoop?: AgentLoop
  authToken?: string
  strategy?: MemoryStrategy
  router?: ProviderRouter
}) {
  const fastify = Fastify({ logger: false })
  await fastify.register(chatRoute, {
    router: opts.router ?? makeRouter(),
    strategy: opts.strategy ?? makeStrategy(),
    authToken: opts.authToken,
    agentLoop: opts.agentLoop,
  })
  return fastify
}

// ── Existing tests (via buildServer — uses AgentLoop automatically) ───────────

it("returns 401 when authToken is set and no header provided", async () => {
  const app = await buildServer(makeConfig("secret"), makeRouter(), makeStrategy())
  const res = await app.inject({ method: "POST", url: "/v1/agent/chat", payload: { message: "hi" } })
  expect(res.statusCode).toBe(401)
})

it("returns 401 when authToken is set and wrong token provided", async () => {
  const app = await buildServer(makeConfig("secret"), makeRouter(), makeStrategy())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    headers: { authorization: "Bearer wrong" },
    payload: { message: "hi" },
  })
  expect(res.statusCode).toBe(401)
})

it("returns response when no authToken configured", async () => {
  const router = makeRouter()
  const app = await buildServer(makeConfig(), router, makeStrategy())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "ping" },
  })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body)
  expect(body.response).toBe("pong")
  expect(body.sessionId).toBeDefined()
})

it("returns response when correct bearer token provided", async () => {
  const router = makeRouter()
  const app = await buildServer(makeConfig("secret"), router, makeStrategy())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    headers: { authorization: "Bearer secret" },
    payload: { message: "ping" },
  })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body)
  expect(body.response).toBe("pong")
})

it("passes sessionId from request to strategy", async () => {
  const strategy = makeStrategy()
  const app = await buildServer(makeConfig(), makeRouter(), strategy)
  await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "hi", sessionId: "my-session" },
  })
  expect(strategy.ensureSession).toHaveBeenCalledWith("my-session")
})

// ── 输入校验 ──────────────────────────────────────────────────

it("returns 400 when message is empty string", async () => {
  const app = await buildServer(makeConfig(), makeRouter(), makeStrategy())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "" },
  })
  expect(res.statusCode).toBe(400)
  const body = JSON.parse(res.body)
  expect(body.error).toMatch(/message/)
})

it("returns 400 when message is missing", async () => {
  const app = await buildServer(makeConfig(), makeRouter(), makeStrategy())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: {},
  })
  expect(res.statusCode).toBe(400)
})

it("returns 400 when message is whitespace only", async () => {
  const app = await buildServer(makeConfig(), makeRouter(), makeStrategy())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "   " },
  })
  expect(res.statusCode).toBe(400)
})

// ── appendTurn 被调用 ─────────────────────────────────────────

it("calls appendTurn after successful chat", async () => {
  const strategy = makeStrategy()
  const app = await buildServer(makeConfig(), makeRouter(), strategy)
  await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "hello", sessionId: "s1" },
  })
  expect(strategy.appendTurn).toHaveBeenCalledWith(
    "s1",
    { role: "user", content: "hello" },
    { role: "assistant", content: "pong" },
  )
})

it("calls getContext with the user message", async () => {
  const strategy = makeStrategy()
  const app = await buildServer(makeConfig(), makeRouter(), strategy)
  await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "test message", sessionId: "s99" },
  })
  expect(strategy.getContext).toHaveBeenCalledWith("s99", "test message")
})

// ── sessionId 自动生成 ────────────────────────────────────────

it("generates sessionId when not provided", async () => {
  const app = await buildServer(makeConfig(), makeRouter(), makeStrategy())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "hi" },
  })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body)
  expect(body.sessionId).toBeDefined()
  expect(typeof body.sessionId).toBe("string")
  expect(body.sessionId.length).toBeGreaterThan(0)
})

// ── AgentLoop 专项测试 ────────────────────────────────────────

describe("AgentLoop path", () => {
  // 1. 无工具调用 — message_delta + agent_end
  it("non-stream: no tool calls → returns response with toolsUsed=[]", async () => {
    const events: AgentEvent[] = [
      { type: "turn_start", turn: 1 },
      { type: "message_delta", delta: "Hello world" },
      { type: "turn_end", message: { role: "assistant", content: "Hello world" }, toolCallCount: 0 },
      { type: "agent_end", totalTurns: 1, stopReason: "no_tool_calls" },
    ]
    const app = await buildChatApp({ agentLoop: makeAgentLoop(events) })
    const res = await app.inject({
      method: "POST",
      url: "/v1/agent/chat",
      payload: { message: "ping", sessionId: "s1" },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.response).toBe("Hello world")
    expect(body.sessionId).toBe("s1")
    expect(body.totalTurns).toBe(1)
    expect(body.toolsUsed).toEqual([])
  })

  // 2. 有工具调用 — tool_start + tool_end + message_delta + agent_end
  it("non-stream: with tool calls → returns toolsUsed with tool names", async () => {
    const events: AgentEvent[] = [
      { type: "turn_start", turn: 1 },
      { type: "tool_start", toolCallId: "tc1", toolName: "exec", args: { command: "ls" } },
      { type: "tool_end", toolCallId: "tc1", toolName: "exec", result: { content: "file.txt", isError: false }, isError: false, durationMs: 10 },
      { type: "message_delta", delta: "Done" },
      { type: "turn_end", message: { role: "assistant", content: "Done" }, toolCallCount: 1 },
      { type: "agent_end", totalTurns: 2, stopReason: "no_tool_calls" },
    ]
    const app = await buildChatApp({ agentLoop: makeAgentLoop(events) })
    const res = await app.inject({
      method: "POST",
      url: "/v1/agent/chat",
      payload: { message: "run ls" },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.response).toBe("Done")
    expect(body.toolsUsed).toEqual(["exec"])
    expect(body.totalTurns).toBe(2)
  })

  // 3. 工具失败 — tool_end.isError=true → response 仍然正常返回（不 500）
  it("non-stream: tool failure → still returns 200 with response", async () => {
    const events: AgentEvent[] = [
      { type: "turn_start", turn: 1 },
      { type: "tool_start", toolCallId: "tc1", toolName: "exec", args: {} },
      { type: "tool_end", toolCallId: "tc1", toolName: "exec", result: { content: "error!", isError: true }, isError: true, durationMs: 5 },
      { type: "message_delta", delta: "I could not do it" },
      { type: "turn_end", message: { role: "assistant", content: "I could not do it" }, toolCallCount: 1 },
      { type: "agent_end", totalTurns: 1, stopReason: "no_tool_calls" },
    ]
    const app = await buildChatApp({ agentLoop: makeAgentLoop(events) })
    const res = await app.inject({
      method: "POST",
      url: "/v1/agent/chat",
      payload: { message: "fail please" },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.response).toBe("I could not do it")
  })

  // 4. 多个 message_delta 拼接
  it("non-stream: multiple message_delta events are concatenated", async () => {
    const events: AgentEvent[] = [
      { type: "turn_start", turn: 1 },
      { type: "message_delta", delta: "Hello " },
      { type: "message_delta", delta: "world" },
      { type: "turn_end", message: { role: "assistant", content: "Hello world" }, toolCallCount: 0 },
      { type: "agent_end", totalTurns: 1, stopReason: "no_tool_calls" },
    ]
    const app = await buildChatApp({ agentLoop: makeAgentLoop(events) })
    const res = await app.inject({
      method: "POST",
      url: "/v1/agent/chat",
      payload: { message: "hi" },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.response).toBe("Hello world")
  })

  // 5. strategy.appendTurn 被正确调用
  it("non-stream: appendTurn called with correct args", async () => {
    const strategy = makeStrategy()
    const events: AgentEvent[] = [
      { type: "turn_start", turn: 1 },
      { type: "message_delta", delta: "reply" },
      { type: "turn_end", message: { role: "assistant", content: "reply" }, toolCallCount: 0 },
      { type: "agent_end", totalTurns: 1, stopReason: "no_tool_calls" },
    ]
    const app = await buildChatApp({ agentLoop: makeAgentLoop(events), strategy })
    await app.inject({
      method: "POST",
      url: "/v1/agent/chat",
      payload: { message: "user msg", sessionId: "sess-42" },
    })
    expect(strategy.appendTurn).toHaveBeenCalledWith(
      "sess-42",
      { role: "user", content: "user msg" },
      { role: "assistant", content: "reply" },
    )
  })

  // 6. sessionId 透传
  it("non-stream: sessionId is echoed back in response", async () => {
    const events: AgentEvent[] = [
      { type: "turn_start", turn: 1 },
      { type: "message_delta", delta: "ok" },
      { type: "turn_end", message: { role: "assistant", content: "ok" }, toolCallCount: 0 },
      { type: "agent_end", totalTurns: 1, stopReason: "no_tool_calls" },
    ]
    const app = await buildChatApp({ agentLoop: makeAgentLoop(events) })
    const res = await app.inject({
      method: "POST",
      url: "/v1/agent/chat",
      payload: { message: "hi", sessionId: "my-custom-session" },
    })
    const body = JSON.parse(res.body)
    expect(body.sessionId).toBe("my-custom-session")
  })

  // 7. stream: SSE events include tool_start, tool_end, message_delta chunks, done
  it("stream: SSE emits tool_start/tool_end/message_delta/done events", async () => {
    const events: AgentEvent[] = [
      { type: "turn_start", turn: 1 },
      { type: "tool_start", toolCallId: "tc1", toolName: "read", args: { path: "/tmp/f" } },
      { type: "tool_end", toolCallId: "tc1", toolName: "read", result: { content: "data" }, isError: false, durationMs: 3 },
      { type: "message_delta", delta: "here is data" },
      { type: "turn_end", message: { role: "assistant", content: "here is data" }, toolCallCount: 1 },
      { type: "agent_end", totalTurns: 1, stopReason: "no_tool_calls" },
    ]
    const app = await buildChatApp({ agentLoop: makeAgentLoop(events) })
    const res = await app.inject({
      method: "POST",
      url: "/v1/agent/chat",
      payload: { message: "read file", stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/)
    const lines = res.body.split("\n").filter((l: string) => l.startsWith("data: "))
    const parsed = lines
      .filter((l: string) => l !== "data: [DONE]")
      .map((l: string) => JSON.parse(l.slice("data: ".length)))

    const toolStart = parsed.find((e: { type?: string }) => e.type === "tool_start")
    const toolEnd = parsed.find((e: { type?: string }) => e.type === "tool_end")
    const delta = parsed.find((e: { choices?: unknown[] }) => e.choices)
    const done = parsed.find((e: { type?: string }) => e.type === "done")

    expect(toolStart?.toolName).toBe("read")
    expect(toolEnd?.toolName).toBe("read")
    expect((delta?.choices as Array<{ delta: { content: string } }>)[0]?.delta?.content).toBe("here is data")
    expect(done).toBeDefined()
  })

  // 8. stream: appendTurn called after streaming
  it("stream: appendTurn is called after streaming completes", async () => {
    const strategy = makeStrategy()
    const events: AgentEvent[] = [
      { type: "turn_start", turn: 1 },
      { type: "message_delta", delta: "streamed response" },
      { type: "turn_end", message: { role: "assistant", content: "streamed response" }, toolCallCount: 0 },
      { type: "agent_end", totalTurns: 1, stopReason: "no_tool_calls" },
    ]
    const app = await buildChatApp({ agentLoop: makeAgentLoop(events), strategy })
    await app.inject({
      method: "POST",
      url: "/v1/agent/chat",
      payload: { message: "stream me", sessionId: "stream-sess", stream: true },
    })
    expect(strategy.appendTurn).toHaveBeenCalledWith(
      "stream-sess",
      { role: "user", content: "stream me" },
      { role: "assistant", content: "streamed response" },
    )
  })

  // 9. 认证失败 — 401
  it("returns 401 when authToken required and not provided", async () => {
    const events: AgentEvent[] = [
      { type: "turn_start", turn: 1 },
      { type: "message_delta", delta: "secret" },
      { type: "turn_end", message: { role: "assistant", content: "secret" }, toolCallCount: 0 },
      { type: "agent_end", totalTurns: 1, stopReason: "no_tool_calls" },
    ]
    const app = await buildChatApp({ agentLoop: makeAgentLoop(events), authToken: "tok" })
    const res = await app.inject({
      method: "POST",
      url: "/v1/agent/chat",
      payload: { message: "hi" },
    })
    expect(res.statusCode).toBe(401)
  })

  // 10. 空消息 — 400
  it("returns 400 for empty message even when agentLoop is provided", async () => {
    const events: AgentEvent[] = []
    const app = await buildChatApp({ agentLoop: makeAgentLoop(events) })
    const res = await app.inject({
      method: "POST",
      url: "/v1/agent/chat",
      payload: { message: "" },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ── No-AgentLoop fallback (legacy) path ──────────────────────

describe("legacy path (no agentLoop)", () => {
  it("non-stream: calls router.chat and returns response", async () => {
    const router = makeRouter()
    const app = await buildChatApp({ router })
    const res = await app.inject({
      method: "POST",
      url: "/v1/agent/chat",
      payload: { message: "ping" },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.response).toBe("pong")
    expect(router.chat).toHaveBeenCalled()
  })

  it("stream: calls router.stream", async () => {
    async function* fakeStream() {
      yield { delta: "hi", done: false }
      yield { delta: "", done: true }
    }
    const router = {
      chat: vi.fn(),
      stream: vi.fn().mockReturnValue(fakeStream()),
    } as unknown as ProviderRouter
    const app = await buildChatApp({ router })
    const res = await app.inject({
      method: "POST",
      url: "/v1/agent/chat",
      payload: { message: "ping", stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/)
    expect(router.stream).toHaveBeenCalled()
  })
})
