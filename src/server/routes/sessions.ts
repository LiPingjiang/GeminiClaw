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
      WHERE COALESCE(archived, 0) = 0
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
    // ── DELETE /v1/sessions/:id ── (soft-delete: archive, not permanently delete)
    fastify.delete("/v1/sessions/:id", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const { id } = request.params;
        const session = db.prepare(`SELECT id FROM chat_sessions WHERE id = ?`).get(id);
        if (!session) return reply.status(404).send({ error: "Session not found" });
        db.prepare(`UPDATE chat_sessions SET archived = 1, updated_at = datetime('now') WHERE id = ?`).run(id);
        return reply.send({ archived: id });
    });
    // ── DELETE /v1/sessions/batch ─────────────────────────────────────────────────
    // 批量删除消息数 < maxMessages 的 session
    fastify.delete("/v1/sessions/batch", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const maxMessages = parseInt((request.query as { maxMessages?: string }).maxMessages ?? "16");
        const toDelete = db.prepare(`
            SELECT id FROM chat_sessions WHERE COALESCE(message_count, 0) < ?
        `).all(maxMessages) as Array<{ id: string }>;
        for (const { id } of toDelete) {
            db.prepare(`DELETE FROM chat_messages WHERE session_id = ?`).run(id);
            db.prepare(`DELETE FROM agents WHERE session_id = ?`).run(id);
            db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(id);
        }
        return reply.send({ deleted: toDelete.length, ids: toDelete.map(r => r.id) });
    });
    // ── POST /v1/sessions ────────────────────────────────────────────────────────
    // 创建空 session（供 copy agent 等场景使用）
    fastify.post("/v1/sessions", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const { randomUUID } = await import("crypto");
        const id = randomUUID();
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        db.prepare(`INSERT INTO chat_sessions (id, created_at, updated_at) VALUES (?, ?, ?)`).run(id, now, now);
        return reply.status(201).send({ sessionId: id });
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
    // ── GET /v1/memory/global ────────────────────────────────────────────────────
    // 读取全局记忆文件（AGENT.md + MEMORY.md）
    fastify.get("/v1/memory/global", async (request, reply) => {
        if (!checkAuth(request, authToken)) return reply.status(401).send({ error: "Unauthorized" });
        const { existsSync, readFileSync } = await import("fs");
        const { join } = await import("path");
        const { default: os } = await import("os");
        const root = join(os.homedir(), ".gemeniclaw");
        const agentMd = join(root, "AGENT.md");
        const memoryMd = join(root, "memory", "global", "MEMORY.md");
        return reply.send({
            agentMd: existsSync(agentMd) ? readFileSync(agentMd, "utf-8") : "",
            memoryMd: existsSync(memoryMd) ? readFileSync(memoryMd, "utf-8") : "",
        });
    });
    // ── PATCH /v1/memory/global ───────────────────────────────────────────────────
    fastify.patch("/v1/memory/global", async (request, reply) => {
        if (!checkAuth(request, authToken)) return reply.status(401).send({ error: "Unauthorized" });
        const { agentMd, memoryMd } = request.body as { agentMd?: string; memoryMd?: string };
        const { writeFileSync, mkdirSync } = await import("fs");
        const { join } = await import("path");
        const { default: os } = await import("os");
        const root = join(os.homedir(), ".gemeniclaw");
        if (typeof agentMd === "string") writeFileSync(join(root, "AGENT.md"), agentMd, "utf-8");
        if (typeof memoryMd === "string") {
            mkdirSync(join(root, "memory", "global"), { recursive: true });
            writeFileSync(join(root, "memory", "global", "MEMORY.md"), memoryMd, "utf-8");
        }
        return reply.send({ ok: true });
    });
    // ── GET /v1/sessions/:id/memory ───────────────────────────────────────────────
    // 读取 session 对应 agent 的记忆层
    fastify.get("/v1/sessions/:id/memory", async (request, reply) => {
        if (!checkAuth(request, authToken)) return reply.status(401).send({ error: "Unauthorized" });
        const { id } = request.params;
        const agent = db.prepare(`SELECT id, agent_name FROM agents WHERE session_id = ? AND depth = 0 ORDER BY created_at DESC LIMIT 1`).get(id) as { id: string; agent_name: string } | undefined;
        if (!agent) return reply.send({ agentMd: "", memoryMd: "" });
        const { existsSync, readFileSync } = await import("fs");
        const { join } = await import("path");
        const { default: os } = await import("os");
        const root = join(os.homedir(), ".gemeniclaw", "agents", agent.id);
        return reply.send({
            agentId: agent.id,
            agentName: agent.agent_name,
            agentMd: existsSync(join(root, "AGENT.md")) ? readFileSync(join(root, "AGENT.md"), "utf-8") : "",
            memoryMd: existsSync(join(root, "MEMORY.md")) ? readFileSync(join(root, "MEMORY.md"), "utf-8") : "",
        });
    });
    // ── PATCH /v1/sessions/:id/memory ────────────────────────────────────────────
    fastify.patch("/v1/sessions/:id/memory", async (request, reply) => {
        if (!checkAuth(request, authToken)) return reply.status(401).send({ error: "Unauthorized" });
        const { id } = request.params;
        const agent = db.prepare(`SELECT id FROM agents WHERE session_id = ? AND depth = 0 ORDER BY created_at DESC LIMIT 1`).get(id) as { id: string } | undefined;
        if (!agent) return reply.status(404).send({ error: "No agent for this session" });
        const { agentMd, memoryMd } = request.body as { agentMd?: string; memoryMd?: string };
        const { writeFileSync, mkdirSync } = await import("fs");
        const { join } = await import("path");
        const { default: os } = await import("os");
        const agentDir = join(os.homedir(), ".gemeniclaw", "agents", agent.id);
        mkdirSync(agentDir, { recursive: true });
        if (typeof agentMd === "string") writeFileSync(join(agentDir, "AGENT.md"), agentMd, "utf-8");
        if (typeof memoryMd === "string") writeFileSync(join(agentDir, "MEMORY.md"), memoryMd, "utf-8");
        return reply.send({ ok: true });
    });
    // ── GET /v1/runs/subagent ─────────────────────────────────────────────────
    // subagent_runs 历史记录（多 agent 委派产生，持久化在 SQLite）
    fastify.get("/v1/runs/subagent", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const { limit = "50", offset = "0" } = request.query;
        const rows = db.prepare(`
            SELECT run_id, parent_session_id, parent_agent_id,
                   task_titles, status, started_at, completed_at, error
            FROM subagent_runs
            ORDER BY started_at DESC
            LIMIT ? OFFSET ?
        `).all(parseInt(limit), parseInt(offset));
        return reply.send({ runs: rows, total: rows.length });
    });
}
