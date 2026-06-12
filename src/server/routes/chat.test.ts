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
    evolution: {
      enabled: false,
      code: { enabled: false },
      skill: {
        enabled: false,
        idleThresholdMs: 300000,
        cronIntervalMs: 1800000,
        cooldownMs: 600000,
        maxActionsPerCycle: 2,
        lookbackMs: 86400000,
        maxCandidates: 3,
        minScore: 1,
      },
      dataDir: ".gemini-data",
      idleThresholdMs: 300000,
      cronIntervalMs: 1800000,
      cooldownMs: 600000,
      maxMutationRounds: 3,
      confidenceThreshold: 0.7,
      testPort: 19889,
      postSwitchMonitorMs: 300000,
      failureRateThreshold: 0.1,
      protectedPaths: ["src/config/", "src/twin-system/", ".gemini-data/"],
      maxEvolutionsPerFile24h: 3,
      autoSwitch: false,
      mainBranch: "main",
      maxCyclesPerDay: 0,
      dryRun: false,
      autoApproveRiskLevels: ["low"],
      approvalTimeoutMs: 3600000,
    },
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

// ── 斜杠命令拦截 ──────────────────────────────────────────────

it("intercepts slash commands and bypasses the LLM router", async () => {
  const router = makeRouter()
  const app = await buildServer(makeConfig(), router, makeStrategy())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "/help" },
  })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body)
  // 命令直接走工具，不调用 LLM
  expect(router.chat).not.toHaveBeenCalled()
  expect(body.model).toBe("command")
  expect(body.response).toContain("/技能")
})

it("does not call getContext for slash commands", async () => {
  const strategy = makeStrategy()
  const app = await buildServer(makeConfig(), makeRouter(), strategy)
  await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "/help" },
  })
  expect(strategy.getContext).not.toHaveBeenCalled()
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
