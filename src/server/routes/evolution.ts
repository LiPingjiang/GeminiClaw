// @ts-nocheck
// src/server/routes/evolution.ts
// HTTP API routes for the Evolution Engine.
//
// Endpoints:
//   GET  /v1/evolution/status       — getStatus()
//   POST /v1/evolution/run          — runOnce()
//   POST /v1/evolution/switch       — manualSwitch()
//   POST /v1/evolution/approve/:id  — approveIntent(id, reviewer)
//   GET  /v1/evolution/history      — getHistory(limit)
export async function evolutionRoute(fastify, options) {
    const { evolution } = options;
    // ---------------------------------------------------------------------------
    // GET /v1/evolution/status
    // ---------------------------------------------------------------------------
    fastify.get("/v1/evolution/status", async (_req, reply) => {
        try {
            const status = await evolution.getStatus();
            const cbState = evolution.getCircuitBreaker().getState();
            return reply.send({
                ...status,
                circuitBreaker: cbState,
            });
        }
        catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ error: "Failed to get status" });
        }
    });
    // ---------------------------------------------------------------------------
    // POST /v1/evolution/run
    // ---------------------------------------------------------------------------
    fastify.post("/v1/evolution/run", async (_req, reply) => {
        try {
            const result = await evolution.runOnce();
            return reply.send(result);
        }
        catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ error: "Failed to run evolution cycle" });
        }
    });
    // ---------------------------------------------------------------------------
    // POST /v1/evolution/switch
    // ---------------------------------------------------------------------------
    fastify.post("/v1/evolution/switch", async (_req, reply) => {
        try {
            const result = await evolution.manualSwitch();
            return reply.send(result);
        }
        catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ error: "Failed to switch" });
        }
    });
    // ---------------------------------------------------------------------------
    // POST /v1/evolution/approve/:id
    // ---------------------------------------------------------------------------
    fastify.post("/v1/evolution/approve/:id", async (req, reply) => {
        const { id } = req.params;
        const reviewer = req.body?.reviewer ?? "api";
        try {
            await evolution.approveIntent(id, reviewer);
            return reply.send({ success: true, intentId: id, reviewer });
        }
        catch (err) {
            const message = err.message;
            if (message.includes("No pending review found")) {
                return reply.status(404).send({ error: message });
            }
            fastify.log.error(err);
            return reply.status(500).send({ error: "Failed to approve intent" });
        }
    });
    // ---------------------------------------------------------------------------
    // GET /v1/evolution/history
    // ---------------------------------------------------------------------------
    fastify.get("/v1/evolution/history", async (req, reply) => {
        const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit ?? "20", 10) || 20));
        try {
            const history = await evolution.getHistory(limit);
            return reply.send({ history, count: history.length });
        }
        catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ error: "Failed to get history" });
        }
    });
    // ---------------------------------------------------------------------------
    // POST /v1/evolution/generate-intents
    // ---------------------------------------------------------------------------
    fastify.post("/v1/evolution/generate-intents", async (_req, reply) => {
        try {
            const count = await evolution.generateIntents();
            return reply.send({ generated: count });
        }
        catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ error: "Failed to generate intents" });
        }
    });
    // ---------------------------------------------------------------------------
    // POST /v1/evolution/intents — user-triggered intent
    // ---------------------------------------------------------------------------
    fastify.post("/v1/evolution/intents", async (req, reply) => {
        const body = req.body;
        if (!body.description || !body.targetFiles?.length) {
            return reply.status(400).send({ error: "description and targetFiles are required" });
        }
        try {
            const id = evolution.addUserIntent({
                description: body.description,
                targetFiles: body.targetFiles,
                riskLevel: body.riskLevel ?? "medium",
                evidence: body.evidence,
            });
            return reply.status(201).send({ id });
        }
        catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ error: "Failed to add intent" });
        }
    });
    // ---------------------------------------------------------------------------
    // GET /v1/evolution/candidates
    // ---------------------------------------------------------------------------
    fastify.get("/v1/evolution/candidates", async (_req, reply) => {
        try {
            const reviews = evolution.getDb().listPendingReviews();
            const candidates = reviews.map((r, i) => ({
                index: i + 1,
                intentId: r.intentId,
                description: r.description,
                riskLevel: r.riskLevel,
                targetFiles: r.targetFiles,
                hasPreview: evolution.getDb().hasEvolutionPreview(r.intentId),
                requestedAt: r.requestedAt,
            }));
            return reply.send({ candidates, count: candidates.length });
        }
        catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ error: "Failed to list candidates" });
        }
    });
    // ---------------------------------------------------------------------------
    // GET /v1/evolution/previews/:intentId
    // ---------------------------------------------------------------------------
    fastify.get("/v1/evolution/previews/:intentId", async (req, reply) => {
        const { intentId } = req.params;
        try {
            const previews = evolution.getDb().listEvolutionPreviews(intentId);
            return reply.send({ previews, count: previews.length, ready: previews.length > 0 });
        }
        catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ error: "Failed to get previews" });
        }
    });
    // ---------------------------------------------------------------------------
    // POST /v1/evolution/reject/:id
    // ---------------------------------------------------------------------------
    fastify.post("/v1/evolution/reject/:id", async (req, reply) => {
        const { id } = req.params;
        const reason = req.body?.reason ?? "user-rejected";
        try {
            await evolution.rejectIntent(id, reason);
            return reply.send({ success: true, intentId: id });
        }
        catch (err) {
            const message = err.message;
            if (message.includes("not found") || message.includes("No pending review")) {
                return reply.status(404).send({ error: message });
            }
            fastify.log.error(err);
            return reply.status(500).send({ error: "Failed to reject intent" });
        }
    });
}
