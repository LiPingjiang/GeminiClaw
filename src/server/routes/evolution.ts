// src/server/routes/evolution.ts
// HTTP API routes for the Twin-System Evolution Engine.
//
// Endpoints:
//   GET  /v1/evolution/status       — system status
//   POST /v1/evolution/run          — trigger one evolution cycle
//   POST /v1/evolution/intents      — add user intent
//   GET  /v1/evolution/candidates   — peek at intent queue

import type { FastifyInstance } from "fastify"
import type { TwinSystemInstance } from "../../twin-system/factory.js"

interface EvolutionRouteOpts {
  twinSystem: TwinSystemInstance
}

export async function evolutionRoute(
  fastify: FastifyInstance,
  options: EvolutionRouteOpts,
): Promise<void> {
  const { twinSystem } = options

  // ---------------------------------------------------------------------------
  // GET /v1/evolution/status
  // ---------------------------------------------------------------------------
  fastify.get("/v1/evolution/status", async (_req, reply) => {
    try {
      const stats = twinSystem.aggregator.getStats()
      return reply.send({
        enabled: true,
        queueSize: stats.queueSize,
        totalCollected: stats.totalCollected,
        lastRunAt: stats.lastRunAt,
        sourceBreakdown: stats.sourceBreakdown,
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
      // Collect fresh intents before picking next
      await twinSystem.aggregator.collect()
      const intent = twinSystem.aggregator.next()
      if (!intent) {
        twinSystem.metrics.recordSkipped()
        return reply.send({ success: false, reason: "No intents in queue" })
      }

      const startedAt = Date.now()
      const result = await twinSystem.pipeline.run(intent)

      // Record metrics (same as scheduler's onTrigger)
      twinSystem.metrics.recordCycle({
        intentId: intent.id,
        intentType: intent.type,
        trigger: "manual",
        startedAt,
        success: result.success,
        abortReason: result.abortReason,
        changedFiles: result.mutationResult?.changedFiles ?? [],
        rolled_back: false,
      })

      return reply.send({
        success: result.success,
        intent: intent.description,
        changedFiles: result.mutationResult?.changedFiles ?? [],
        abortReason: result.abortReason,
        durationMs: Date.now() - startedAt,
      })
    } catch (err) {
      fastify.log.error(err)
      return reply.status(500).send({ error: "Failed to run evolution cycle" })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /v1/evolution/intents — add user-triggered intent
  // ---------------------------------------------------------------------------
  fastify.post("/v1/evolution/intents", async (req, reply) => {
    const body = req.body as {
      description?: string
      targetFiles?: string[]
      riskLevel?: string
      evidence?: string[]
    }
    if (!body.description || !body.targetFiles?.length) {
      return reply.status(400).send({ error: "description and targetFiles are required" })
    }
    try {
      // Inject manually via a one-shot source that auto-removes itself after collect
      const manualSource = {
        name: "manual-user",
        _consumed: false,
        generate() {
          if (this._consumed) return []
          this._consumed = true
          return [{
            type: (body.riskLevel === "high" ? "behavior_fix" : "optimization") as "behavior_fix" | "optimization",
            description: body.description!,
            targetFiles: body.targetFiles!,
            evidence: body.evidence ?? ["User-submitted intent"],
            riskLevel: (body.riskLevel ?? "low") as "low" | "medium" | "high",
            priority: 0.8,
            dedupKey: `manual:${Date.now()}:${body.description!.slice(0, 30)}`,
          }]
        },
      }
      twinSystem.aggregator.addSource(manualSource)
      const newIntents = await twinSystem.aggregator.collect()
      return reply.status(201).send({
        queued: true,
        description: body.description,
        intentCount: newIntents.length,
        queueSize: twinSystem.aggregator.size(),
      })
    } catch (err) {
      fastify.log.error(err)
      return reply.status(500).send({ error: "Failed to add intent" })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /v1/evolution/candidates — peek at the intent queue
  // ---------------------------------------------------------------------------
  fastify.get("/v1/evolution/candidates", async (_req, reply) => {
    try {
      const candidates = twinSystem.aggregator.peek(10)
      return reply.send({
        candidates: candidates.map((c, i) => ({
          index: i + 1,
          id: c.id,
          type: c.type,
          description: c.description,
          riskLevel: c.riskLevel,
          targetFiles: c.targetFiles,
        })),
        count: candidates.length,
      })
    } catch (err) {
      fastify.log.error(err)
      return reply.status(500).send({ error: "Failed to list candidates" })
    }
  })
}
