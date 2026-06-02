// src/server/routes/approvals.ts
// HTTP API routes for the evolution approval workflow.
//
// Endpoints:
//   GET  /v1/evolution/approvals            — list pending approvals
//   POST /v1/evolution/approvals/:id/approve — approve a request
//   POST /v1/evolution/approvals/:id/reject  — reject a request

import type { FastifyInstance } from "fastify"
import type { ApprovalGate } from "../../twin-system/approval-gate.js"

interface ApprovalRouteOpts {
  approvalGate: ApprovalGate
}

export async function approvalRoute(
  fastify: FastifyInstance,
  options: ApprovalRouteOpts,
): Promise<void> {
  const { approvalGate } = options

  // ---------------------------------------------------------------------------
  // GET /v1/evolution/approvals — list pending approval requests
  // ---------------------------------------------------------------------------
  fastify.get("/v1/evolution/approvals", async (_req, reply) => {
    const pending = approvalGate.listPending()
    return reply.send({
      pending: pending.map((r) => ({
        id: r.id,
        intentId: r.intentId,
        intentType: r.intentType,
        riskLevel: r.riskLevel,
        description: r.intentDescription,
        summary: r.summary,
        createdAt: new Date(r.createdAt).toISOString(),
        expiresAt: new Date(r.expiresAt).toISOString(),
        remainingMs: Math.max(0, r.expiresAt - Date.now()),
      })),
      count: pending.length,
    })
  })

  // ---------------------------------------------------------------------------
  // POST /v1/evolution/approvals/:id/approve
  // ---------------------------------------------------------------------------
  fastify.post("/v1/evolution/approvals/:id/approve", async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { decidedBy?: string } | undefined
    const ok = approvalGate.approve(id, body?.decidedBy)
    if (!ok) {
      return reply.status(404).send({
        error: "Approval request not found or already resolved",
        id,
      })
    }
    return reply.send({ approved: true, id })
  })

  // ---------------------------------------------------------------------------
  // POST /v1/evolution/approvals/:id/reject
  // ---------------------------------------------------------------------------
  fastify.post("/v1/evolution/approvals/:id/reject", async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { decidedBy?: string } | undefined
    const ok = approvalGate.reject(id, body?.decidedBy)
    if (!ok) {
      return reply.status(404).send({
        error: "Approval request not found or already resolved",
        id,
      })
    }
    return reply.send({ rejected: true, id })
  })
}
