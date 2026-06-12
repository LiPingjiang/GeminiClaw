// src/server/routes/skill-evolution.ts
// HTTP API routes for the Hermes-style SKILL evolution engine.
//
// Endpoints:
//   GET  /v1/skill-evolution/status   — skill engine status + skill count
//   GET  /v1/skills                   — list all crystallised skills
//   GET  /v1/skills/:name             — read one skill (meta + body)
//   POST /v1/skill-evolution/scan     — manually scan a batch of real
//                                       conversations and create/refine skills
//
// The engine is read from globalThis.__evolutionSystem (set in index.ts) so we
// don't have to thread it through buildServer's signature.

import type { FastifyInstance } from "fastify"
import type { EvolutionSystem } from "../../evolution-core/orchestrator.js"
import {
  ConversationCandidateSource,
  type CandidateScanFilter,
} from "../../skill-evolution/index.js"
import type { Db } from "../../db/client.js"

interface SkillRouteOpts {
  db: Db
}

interface ScanRequestBody extends CandidateScanFilter {
  /** Override lookback window in milliseconds. */
  lookbackMs?: number
  /** Convenience: lookback window in days (ignored if lookbackMs is set). */
  days?: number
}

function getEvolution(): EvolutionSystem | undefined {
  return (globalThis as any).__evolutionSystem as EvolutionSystem | undefined
}

export async function skillEvolutionRoute(
  fastify: FastifyInstance,
  options: SkillRouteOpts,
): Promise<void> {
  const { db } = options

  // ---------------------------------------------------------------------------
  // GET /v1/skill-evolution/status
  // ---------------------------------------------------------------------------
  fastify.get("/v1/skill-evolution/status", async (_req, reply) => {
    const evo = getEvolution()
    if (!evo) return reply.status(503).send({ error: "Evolution system not initialised" })
    return reply.send(evo.skill.status())
  })

  // ---------------------------------------------------------------------------
  // GET /v1/skills — list all skills
  // ---------------------------------------------------------------------------
  fastify.get("/v1/skills", async (_req, reply) => {
    const evo = getEvolution()
    if (!evo) return reply.status(503).send({ error: "Evolution system not initialised" })
    const store = evo.skill.getStore()
    const skills = store.listAll().map((s) => s.meta)
    return reply.send({ root: store.root, count: skills.length, skills })
  })

  // ---------------------------------------------------------------------------
  // GET /v1/skills/:name — read one skill
  // ---------------------------------------------------------------------------
  fastify.get("/v1/skills/:name", async (req, reply) => {
    const evo = getEvolution()
    if (!evo) return reply.status(503).send({ error: "Evolution system not initialised" })
    const { name } = req.params as { name: string }
    const store = evo.skill.getStore()
    if (!store.has(name)) return reply.status(404).send({ error: `Skill '${name}' not found` })
    const skill = store.get(name)
    return reply.send(skill)
  })

  // ---------------------------------------------------------------------------
  // POST /v1/skill-evolution/scan — manual scan + reflect over real convos
  //   body: { since?, until?, sessionIds?, keyword?, maxCandidates?,
  //           lookbackMs?, days? }
  //
  // Note: the manual scan deliberately uses a wide default lookback window
  // (30 days) rather than the automatic engine's tight 24h window, because a
  // human triggering a scan usually wants to mine the whole recent history.
  // ---------------------------------------------------------------------------
  fastify.post("/v1/skill-evolution/scan", async (req, reply) => {
    const evo = getEvolution()
    if (!evo) return reply.status(503).send({ error: "Evolution system not initialised" })

    const body = (req.body ?? {}) as ScanRequestBody
    const DAY_MS = 24 * 60 * 60 * 1000
    const lookbackMs =
      body.lookbackMs ?? (body.days ? body.days * DAY_MS : 30 * DAY_MS)

    try {
      const source = new ConversationCandidateSource(
        db,
        { lookbackMs },
        {
          since: body.since,
          until: body.until,
          sessionIds: body.sessionIds,
          keyword: body.keyword,
          maxCandidates: body.maxCandidates,
          maxSampleMessages: body.maxSampleMessages,
        },
        // Pass the shared LLM client so long sessions are decomposed into
        // per-task candidates (SCHEME 2). Without it the source falls back to
        // lossy whole-session compression and rarely yields a reusable skill.
        evo.skillLlm,
      )
      const result = await evo.skill.runWithSource(source, "manual")
      return reply.send(result)
    } catch (err) {
      fastify.log.error(err)
      return reply.status(500).send({ error: "Failed to run skill scan" })
    }
  })
}
