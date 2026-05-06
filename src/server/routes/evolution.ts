// src/server/routes/evolution.ts
// HTTP API routes for the Evolution Engine.
//
// Endpoints:
//   GET  /v1/evolution/status       — getStatus()
//   POST /v1/evolution/run          — runOnce()
//   POST /v1/evolution/switch       — manualSwitch()
//   POST /v1/evolution/approve/:id  — approveIntent(id, reviewer)
//   GET  /v1/evolution/history      — getHistory(limit)

import type { FastifyInstance, FastifyPluginOptions } from "fastify"
import type { EvolutionEngine } from "../../evolution/index.js"

export interface EvolutionRouteOptions extends FastifyPluginOptions {
  evolution: EvolutionEngine
}

export async function evolutionRoute(
  fastify: FastifyInstance,
  options: EvolutionRouteOptions
): Promise<void> {
  const { evolution } = options

  // ---------------------------------------------------------------------------
  // GET /v1/evolution/status
  // ---------------------------------------------------------------------------
  fastify.get("/v1/evolution/status", async (_req, reply) => {
    try {
      const status = await evolution.getStatus()
      const cbState = evolution.getCircuitBreaker().getState()
      return reply.send({
        ...status,
        circuitBreaker: cbState,
      })
    } catch (err) {
      fastify.log.error(err)
      return reply.status(500).send({ error: "Failed to get status" })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /v1/evolution/run
  // ---------------------------------------------------------------------------
  fastify.post("/v1/evolution/run", async (_req, reply) => {
    try {
      const result = await evolution.runOnce()
      return reply.send(result)
    } catch (err) {
      fastify.log.error(err)
      return reply.status(500).send({ error: "Failed to run evolution cycle" })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /v1/evolution/switch
  // ---------------------------------------------------------------------------
  fastify.post("/v1/evolution/switch", async (_req, reply) => {
    try {
      const result = await evolution.manualSwitch()
      return reply.send(result)
    } catch (err) {
      fastify.log.error(err)
      return reply.status(500).send({ error: "Failed to switch" })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /v1/evolution/approve/:id
  // ---------------------------------------------------------------------------
  fastify.post<{
    Params: { id: string }
    Body: { reviewer?: string }
  }>("/v1/evolution/approve/:id", async (req, reply) => {
    const { id } = req.params
    const reviewer = (req.body as { reviewer?: string })?.reviewer ?? "api"

    try {
      await evolution.approveIntent(id, reviewer)
      return reply.send({ success: true, intentId: id, reviewer })
    } catch (err) {
      const message = (err as Error).message
      if (message.includes("No pending review found")) {
        return reply.status(404).send({ error: message })
      }
      fastify.log.error(err)
      return reply.status(500).send({ error: "Failed to approve intent" })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /v1/evolution/history
  // ---------------------------------------------------------------------------
  fastify.get<{
    Querystring: { limit?: string }
  }>("/v1/evolution/history", async (req, reply) => {
    const limit = Math.min(
      100,
      Math.max(1, parseInt((req.query as { limit?: string })?.limit ?? "20", 10) || 20)
    )

    try {
      const history = await evolution.getHistory(limit)
      return reply.send({ history, count: history.length })
    } catch (err) {
      fastify.log.error(err)
      return reply.status(500).send({ error: "Failed to get history" })
    }
  })
}
