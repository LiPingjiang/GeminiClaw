// src/server/routes/evolution.test.ts
// Unit tests for the Evolution HTTP API routes.

import { describe, it, expect, vi, beforeEach } from "vitest"
import Fastify from "fastify"
import { evolutionRoute } from "./evolution.js"
import type { EvolutionEngine } from "../../evolution/index.js"
import type { CircuitBreaker } from "../../evolution/circuit-breaker/circuit-breaker.js"

// ---------------------------------------------------------------------------
// Mock EvolutionEngine
// ---------------------------------------------------------------------------

function makeMockCircuitBreaker(): Partial<CircuitBreaker> {
  return {
    getState: vi.fn().mockReturnValue({ isOpen: false }),
  }
}

function makeMockEvolution(): Partial<EvolutionEngine> {
  return {
    getStatus: vi.fn().mockResolvedValue({
      enabled: true,
      activeSlot: "a",
      standbySlot: "b",
      pendingIntents: 2,
      traceCount: 10,
    }),
    runOnce: vi.fn().mockResolvedValue({
      skipped: true,
      skipReason: "no pending intents",
      validationResults: [],
    }),
    manualSwitch: vi.fn().mockResolvedValue({
      success: true,
      fromSlot: "b",
      toSlot: "a",
    }),
    approveIntent: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue([
      { id: 1, intentId: "intent-1", type: "switch", fromSlot: "b", toSlot: "a", changedFiles: [], recordedAt: Date.now() },
    ]),
    getCircuitBreaker: vi.fn().mockReturnValue(makeMockCircuitBreaker() as CircuitBreaker),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Evolution HTTP Routes", () => {
  let mockEvolution: Partial<EvolutionEngine>

  beforeEach(() => {
    vi.clearAllMocks()
    mockEvolution = makeMockEvolution()
  })

  async function buildTestServer() {
    const fastify = Fastify({ logger: false })
    await fastify.register(evolutionRoute, {
      evolution: mockEvolution as EvolutionEngine,
    })
    return fastify
  }

  // -------------------------------------------------------------------------
  // GET /v1/evolution/status
  // -------------------------------------------------------------------------

  it("GET /v1/evolution/status returns status with circuitBreaker", async () => {
    const fastify = await buildTestServer()
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/evolution/status",
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.enabled).toBe(true)
    expect(body.activeSlot).toBe("a")
    expect(body.pendingIntents).toBe(2)
    expect(body.circuitBreaker).toBeDefined()
    expect((body.circuitBreaker as Record<string, unknown>).isOpen).toBe(false)
  })

  // -------------------------------------------------------------------------
  // POST /v1/evolution/run
  // -------------------------------------------------------------------------

  it("POST /v1/evolution/run returns runOnce result", async () => {
    const fastify = await buildTestServer()
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/evolution/run",
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.skipped).toBe(true)
    expect(body.skipReason).toBe("no pending intents")
  })

  // -------------------------------------------------------------------------
  // POST /v1/evolution/switch
  // -------------------------------------------------------------------------

  it("POST /v1/evolution/switch returns switch result", async () => {
    const fastify = await buildTestServer()
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/evolution/switch",
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.success).toBe(true)
    expect(body.fromSlot).toBe("b")
    expect(body.toSlot).toBe("a")
  })

  // -------------------------------------------------------------------------
  // POST /v1/evolution/approve/:id
  // -------------------------------------------------------------------------

  it("POST /v1/evolution/approve/:id approves the intent", async () => {
    const fastify = await buildTestServer()
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/evolution/approve/intent-123",
      payload: { reviewer: "alice" },
      headers: { "content-type": "application/json" },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.success).toBe(true)
    expect(body.intentId).toBe("intent-123")
    expect(body.reviewer).toBe("alice")
    expect(mockEvolution.approveIntent).toHaveBeenCalledWith("intent-123", "alice")
  })

  it("POST /v1/evolution/approve/:id returns 404 when intent not found", async () => {
    ;(mockEvolution.approveIntent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("No pending review found for intent missing-id")
    )

    const fastify = await buildTestServer()
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/evolution/approve/missing-id",
    })

    expect(res.statusCode).toBe(404)
  })

  it("POST /v1/evolution/approve/:id defaults reviewer to 'api' when not provided", async () => {
    const fastify = await buildTestServer()
    await fastify.inject({
      method: "POST",
      url: "/v1/evolution/approve/intent-456",
    })

    expect(mockEvolution.approveIntent).toHaveBeenCalledWith("intent-456", "api")
  })

  // -------------------------------------------------------------------------
  // GET /v1/evolution/history
  // -------------------------------------------------------------------------

  it("GET /v1/evolution/history returns history list", async () => {
    const fastify = await buildTestServer()
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/evolution/history",
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(Array.isArray(body.history)).toBe(true)
    expect(body.count).toBe(1)
    expect(mockEvolution.getHistory).toHaveBeenCalledWith(20)
  })

  it("GET /v1/evolution/history respects limit query param", async () => {
    const fastify = await buildTestServer()
    await fastify.inject({
      method: "GET",
      url: "/v1/evolution/history?limit=5",
    })

    expect(mockEvolution.getHistory).toHaveBeenCalledWith(5)
  })

  it("GET /v1/evolution/history clamps limit to 100", async () => {
    const fastify = await buildTestServer()
    await fastify.inject({
      method: "GET",
      url: "/v1/evolution/history?limit=999",
    })

    expect(mockEvolution.getHistory).toHaveBeenCalledWith(100)
  })
})
