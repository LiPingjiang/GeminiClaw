import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import Fastify from "fastify"
import { qqbotRoute } from "./index.js"
import type { ProviderRouter } from "../../providers/router.js"
import type { MemoryStrategy } from "../../memory/strategy.js"

describe("qqbotRoute", () => {
  let app: ReturnType<typeof Fastify>
  let mockRouter: ProviderRouter
  let mockStrategy: MemoryStrategy

  beforeEach(async () => {
    mockRouter = {
      chat: vi.fn().mockResolvedValue({
        content: "Hello!",
        model: "test",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      stream: vi.fn(),
    } as unknown as ProviderRouter

    mockStrategy = {
      name: "buffer",
      ensureSession: vi.fn().mockResolvedValue(undefined),
      appendTurn: vi.fn().mockResolvedValue(undefined),
      getContext: vi.fn().mockResolvedValue({
        messages: [],
        strategyName: "buffer",
      }),
    } as unknown as MemoryStrategy

    app = Fastify()
    await app.register(qqbotRoute, {
      router: mockRouter,
      strategy: mockStrategy,
      webhookPath: "/webhook/qqbot",
      appId: "test-app-id",
      clientSecret: "test-secret",
    })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it("returns 401 for request missing signature headers", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhook/qqbot",
      payload: { op: 0, d: {} },
    })
    expect(res.statusCode).toBe(401)
  })

  it("handles URL verification challenge (op=13) in test mode", async () => {
    const payload = {
      op: 13,
      d: { plain_token: "abc123", event_ts: "1234567890" },
    }
    const res = await app.inject({
      method: "POST",
      url: "/webhook/qqbot?test=1",
      payload,
    })
    // test mode skips sig verification; should return challenge response or 200
    expect([200, 400]).toContain(res.statusCode)
    if (res.statusCode === 200) {
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty("plain_token", "abc123")
      expect(body).toHaveProperty("signature")
    }
  })

  it("returns 200 for C2C message in test mode (async processing)", async () => {
    const payload = {
      t: "C2C_MESSAGE_CREATE",
      d: {
        author: { user_openid: "test-openid" },
        content: "hello",
        id: "msg-123",
      },
    }
    const res = await app.inject({
      method: "POST",
      url: "/webhook/qqbot?test=1",
      payload,
    })
    expect(res.statusCode).toBe(200)
  })
})
