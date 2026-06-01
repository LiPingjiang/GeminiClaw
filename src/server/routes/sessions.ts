// @ts-nocheck
function checkAuth(request, authToken) {
    if (!authToken)
        return true;
    const auth = request.headers["authorization"];
    return typeof auth === "string" && auth === `Bearer ${authToken}`;
}
export async function sessionsRoute(fastify, opts) {
    const { db, authToken } = opts;
    // ── GET /v1/sessions ────────────────────────────────────────────────────────
    // 列出所有 session，按最近更新排序
    fastify.get("/v1/sessions", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const { limit = "50", offset = "0" } = request.query;
        const rows = db.prepare(`
      SELECT id, title, created_at, updated_at, message_count
      FROM chat_sessions
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).all(parseInt(limit), parseInt(offset));
        return reply.send({ sessions: rows, total: rows.length });
    });
    // ── GET /v1/sessions/:id ─────────────────────────────────────────────────────
    // 查某个 session 的元信息
    fastify.get("/v1/sessions/:id", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const { id } = request.params;
        const session = db.prepare(`
      SELECT id, title, created_at, updated_at, message_count
      FROM chat_sessions WHERE id = ?
    `).get(id);
        if (!session)
            return reply.status(404).send({ error: "Session not found" });
        return reply.send({ session });
    });
    // ── GET /v1/sessions/:id/messages ────────────────────────────────────────────
    // 查某个 session 的完整对话历史
    fastify.get("/v1/sessions/:id/messages", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const { id } = request.params;
        const session = db.prepare(`SELECT id FROM chat_sessions WHERE id = ?`).get(id);
        if (!session)
            return reply.status(404).send({ error: "Session not found" });
        const { limit = "200", offset = "0" } = request.query;
        const messages = db.prepare(`
      SELECT id, role, content, created_at
      FROM chat_messages
      WHERE session_id = ?
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    `).all(id, parseInt(limit), parseInt(offset));
        return reply.send({ session_id: id, messages, total: messages.length });
    });
}
