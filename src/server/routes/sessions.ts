// @ts-nocheck
function checkAuth(request, authToken) {
    if (!authToken)
        return true;
    const auth = request.headers["authorization"];
    return typeof auth === "string" && auth === `Bearer ${authToken}`;
}
export async function sessionsRoute(fastify, opts) {
    const { db, authToken, router } = opts;
    // ── GET /v1/sessions ────────────────────────────────────────────────────────
    // 列出所有 session，按最近更新排序
    fastify.get("/v1/sessions", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const { limit = "50", offset = "0" } = request.query;
        const rows = db.prepare(`
      SELECT id, title, created_at, updated_at, message_count, main_agent_id
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
    // ── PATCH /v1/sessions/:id/title ─────────────────────────────────────────────
    // 手动更新 session 标题
    fastify.patch("/v1/sessions/:id/title", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const { id } = request.params;
        const { title } = request.body ?? {};
        if (typeof title !== "string" || !title.trim()) {
            return reply.status(400).send({ error: "title is required" });
        }
        const session = db.prepare(`SELECT id FROM chat_sessions WHERE id = ?`).get(id);
        if (!session) return reply.status(404).send({ error: "Session not found" });
        db.prepare(`UPDATE chat_sessions SET title = ? WHERE id = ?`).run(title.trim(), id);
        return reply.send({ id, title: title.trim() });
    });
    // ── POST /v1/sessions/:id/title/generate ─────────────────────────────────────
    // 用 LLM 自动生成 session 标题并写入
    fastify.post("/v1/sessions/:id/title/generate", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        if (!router) return reply.status(503).send({ error: "Router not available" });
        const { id } = request.params;
        const session = db.prepare(`SELECT id FROM chat_sessions WHERE id = ?`).get(id);
        if (!session) return reply.status(404).send({ error: "Session not found" });
        // 取前20条 user/assistant 消息作为摘要素材
        const msgs = db.prepare(`
            SELECT role, content FROM chat_messages
            WHERE session_id = ? AND role IN ('user','assistant')
            ORDER BY id ASC LIMIT 20
        `).all(id);
        if (msgs.length === 0) return reply.status(400).send({ error: "No messages" });
        const digest = msgs.map(m => `${m.role === 'user' ? 'U' : 'A'}: ${m.content.slice(0, 200)}`).join('\n');
        const response = await router.chat([
            { role: "system", content: "你是一个标题生成助手。根据对话内容生成一个简洁的中文标题，最多15个字，不加引号，不加标点，只输出标题本身。" },
            { role: "user", content: `以下是对话摘要，请生成标题：\n\n${digest}` },
        ]);
        const title = (response.content ?? "").trim().slice(0, 30);
        if (!title) return reply.status(500).send({ error: "LLM returned empty title" });
        db.prepare(`UPDATE chat_sessions SET title = ? WHERE id = ?`).run(title, id);
        return reply.send({ id, title });
    });
}
