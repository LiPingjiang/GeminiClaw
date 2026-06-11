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
import { ConversationIntentSource, type ScanFilter } from "../../twin-system/conversation-intent-source.js"

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

  // ---------------------------------------------------------------------------
  // POST /v1/evolution/scan-conversations
  // Scan a batch of real conversations, turn problematic ones into
  // evidence-anchored intents, and (optionally) run an evolution cycle on the
  // top one immediately. This is the manual test-closed-loop entry point.
  //
  // Body (all optional):
  //   { since, until, sessionIds, keyword, maxIntents, maxSampleMessages, run }
  //   - since/until: ISO datetime (SQLite "YYYY-MM-DD HH:MM:SS" or ISO)
  //   - sessionIds:  string[] of specific sessions to scan
  //   - keyword:     only scan sessions containing this substring
  //   - run:         if true, immediately run one evolution cycle on the
  //                  highest-priority scanned intent (default false = queue only)
  // ---------------------------------------------------------------------------
  fastify.post("/v1/evolution/scan-conversations", async (req, reply) => {
    const body = (req.body ?? {}) as ScanFilter & { run?: boolean }
    try {
      const normalize = (t?: string): string | undefined =>
        t ? t.replace("T", " ").slice(0, 19) : undefined

      const filter: ScanFilter = {
        since: normalize(body.since),
        until: normalize(body.until),
        sessionIds: body.sessionIds,
        keyword: body.keyword,
        maxIntents: body.maxIntents,
        maxSampleMessages: body.maxSampleMessages,
      }

      const source = new ConversationIntentSource(twinSystem.db, {}, filter)
      // Register a one-shot source so the aggregator picks up scanned intents,
      // applying its normal dedup + priority logic.
      let consumed = false
      twinSystem.aggregator.addSource({
        name: "conversation-scan-manual",
        generate() {
          if (consumed) return []
          consumed = true
          return source.generate()
        },
      })

      const newIntents = await twinSystem.aggregator.collect()
      const scanned = newIntents.filter(
        (i) => typeof i.id === "string",
      )

      if (!body.run) {
        return reply.status(201).send({
          scanned: scanned.length,
          queueSize: twinSystem.aggregator.size(),
          intents: scanned.map((i) => ({
            id: i.id,
            riskLevel: i.riskLevel,
            evidence: i.evidence,
            preview: i.description.slice(0, 120),
          })),
        })
      }

      // run = true: immediately run one cycle on the next (highest-priority) intent
      const intent = twinSystem.aggregator.next()
      if (!intent) {
        return reply.send({ scanned: scanned.length, ran: false, reason: "No intents produced from scan" })
      }
      const startedAt = Date.now()
      const result = await twinSystem.pipeline.run(intent)
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
        scanned: scanned.length,
        ran: true,
        intentId: intent.id,
        success: result.success,
        changedFiles: result.mutationResult?.changedFiles ?? [],
        abortReason: result.abortReason,
        durationMs: Date.now() - startedAt,
      })
    } catch (err) {
      fastify.log.error(err)
      return reply.status(500).send({ error: "Failed to scan conversations" })
    }
  })
}
