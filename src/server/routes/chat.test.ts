import { it, expect, vi } from "vitest"
import { buildServer } from "../index.js"
import type { ProviderRouter } from "../../providers/router.js"
import type { SessionMemory } from "../../memory/session.js"
import type { Config } from "../../config/schema.js"

function makeConfig(authToken?: string): Config {
  return {
    server: { port: 3000, host: "0.0.0.0", authToken },
    providers: [{ name: "p1", type: "anthropic", models: ["m1"] }],
    routing: { default: "p1/m1", fallback: ["p1/m1"] },
    memory: { enabled: true, dataDir: ".data", maxSessionAge: 3600 },
    agent: { maxTurns: 10, timeoutSeconds: 30 },
  }
}

function makeRouter(): ProviderRouter {
  return {
    chat: vi.fn().mockResolvedValue({ content: "pong", model: "m1" }),
  } as unknown as ProviderRouter
}

function makeMemory(): SessionMemory {
  const store: Record<string, unknown[]> = {}
  return {
    get: vi.fn((id: string) => store[id] ?? []),
    append: vi.fn((id: string, msg: unknown) => { store[id] = [...(store[id] ?? []), msg] }),
    clear: vi.fn(),
    generateId: vi.fn(() => "test-session-id"),
  } as unknown as SessionMemory
}

it("returns 401 when authToken is set and no header provided", async () => {
  const app = await buildServer(makeConfig("secret"), makeRouter(), makeMemory())
  const res = await app.inject({ method: "POST", url: "/v1/agent/chat", payload: { message: "hi" } })
  expect(res.statusCode).toBe(401)
})

it("returns 401 when authToken is set and wrong token provided", async () => {
  const app = await buildServer(makeConfig("secret"), makeRouter(), makeMemory())
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
  const app = await buildServer(makeConfig(), router, makeMemory())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "ping" },
  })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body)
  expect(body.response).toBe("pong")
  expect(body.sessionId).toBe("test-session-id")
})

it("returns response when correct bearer token provided", async () => {
  const router = makeRouter()
  const app = await buildServer(makeConfig("secret"), router, makeMemory())
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

it("uses existing sessionId from request body", async () => {
  const router = makeRouter()
  const memory = makeMemory()
  const app = await buildServer(makeConfig(), router, memory)
  await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "hello", sessionId: "existing-id" },
  })
  expect(memory.get).toHaveBeenCalledWith("existing-id")
})
