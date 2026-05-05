// src/server/routes/chat.test.ts
import { it, expect, vi } from "vitest"
import { buildServer } from "../index.js"
import type { ProviderRouter } from "../../providers/router.js"
import type { MemoryStrategy, ConversationContext } from "../../memory/strategy.js"
import type { Config } from "../../config/schema.js"

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
