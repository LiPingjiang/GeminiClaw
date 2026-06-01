// @ts-nocheck
// src/server/routes/agents.ts
import { randomUUID } from "crypto";
import { AgentRepository } from "../../agents/repository.js";
import { TaskRepository } from "../../agents/task-repository.js";
function checkAuth(request, authToken) {
    if (!authToken)
        return true;
    const auth = request.headers["authorization"];
    return typeof auth === "string" && auth === `Bearer ${authToken}`;
}
export async function agentsRoute(fastify, opts) {
    const { db, authToken } = opts;
    const agentRepo = new AgentRepository(db);
    const taskRepo = new TaskRepository(db);
    // ── GET /v1/agents ──────────────────────────────────────────────────────────
    // List all active main agents
    fastify.get("/v1/agents", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const agents = agentRepo.listActiveMainAgents();
        return reply.send({ agents });
    });
    // ── GET /v1/agents/:id ──────────────────────────────────────────────────────
    fastify.get("/v1/agents/:id", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const agent = agentRepo.getById(request.params.id);
        if (!agent)
            return reply.status(404).send({ error: "Agent not found" });
        return reply.send({ agent });
    });
    // ── GET /v1/agents/:id/tasks ────────────────────────────────────────────────
    fastify.get("/v1/agents/:id/tasks", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const agent = agentRepo.getById(request.params.id);
        if (!agent)
            return reply.status(404).send({ error: "Agent not found" });
        const tasks = taskRepo.getTree(request.params.id);
        return reply.send({ tasks });
    });
    // ── POST /v1/sessions/:id/agents ────────────────────────────────────────────
    // Create a main agent for a session
    fastify.post("/v1/sessions/:id/agents", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const sessionId = request.params.id;
        const session = db
            .prepare(`SELECT id FROM chat_sessions WHERE id = ?`)
            .get(sessionId);
        if (!session)
            return reply.status(404).send({ error: "Session not found" });
        const templateName = request.body?.template_name ?? "base";
        const agent = agentRepo.createMainAgent(sessionId, templateName);
        return reply.status(201).send({ agent });
    });
    // ── PATCH /v1/agents/:id ────────────────────────────────────────────────────
    fastify.patch("/v1/agents/:id", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const agent = agentRepo.getById(request.params.id);
        if (!agent)
            return reply.status(404).send({ error: "Agent not found" });
        const { agent_name, description, status } = request.body ?? {};
        const validStatuses = ["active", "idle", "completed", "error"];
        if (status !== undefined && !validStatuses.includes(status)) {
            return reply.status(400).send({ error: `Invalid status: ${status}` });
        }
        agentRepo.update(request.params.id, {
            ...(agent_name !== undefined ? { agent_name } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(status !== undefined
                ? { status: status }
                : {}),
        });
        const updated = agentRepo.getById(request.params.id);
        return reply.send({ agent: updated });
    });
    // ── POST /v1/agents/:id/tasks ───────────────────────────────────────────────
    fastify.post("/v1/agents/:id/tasks", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const agent = agentRepo.getById(request.params.id);
        if (!agent)
            return reply.status(404).send({ error: "Agent not found" });
        const { title, parent_id } = request.body ?? {};
        if (!title)
            return reply.status(400).send({ error: "title is required" });
        try {
            const task = taskRepo.create(request.params.id, agent.session_id, title, parent_id);
            return reply.status(201).send({ task });
        }
        catch (err) {
            return reply
                .status(400)
                .send({ error: err instanceof Error ? err.message : String(err) });
        }
    });
    // ── PATCH /v1/tasks/:id ─────────────────────────────────────────────────────
    fastify.patch("/v1/tasks/:id", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const task = taskRepo.getById(request.params.id);
        if (!task)
            return reply.status(404).send({ error: "Task not found" });
        const { title, description, status } = request.body ?? {};
        const validStatuses = ["pending", "in_progress", "done", "cancelled"];
        if (status !== undefined && !validStatuses.includes(status)) {
            return reply.status(400).send({ error: `Invalid status: ${status}` });
        }
        taskRepo.update(request.params.id, {
            ...(title !== undefined ? { title } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(status !== undefined
                ? { status: status }
                : {}),
        });
        const updated = taskRepo.getById(request.params.id);
        return reply.send({ task: updated });
    });
}
/**
 * Create a session and immediately attach a main agent.
 * Returns { sessionId, agentId }.
 */
export async function createSessionWithAgent(templateName, db) {
    const sessionId = randomUUID();
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    db.prepare(`INSERT INTO chat_sessions (id, created_at, updated_at) VALUES (?, ?, ?)`).run(sessionId, now, now);
    const agentRepo = new AgentRepository(db);
    const agent = agentRepo.createMainAgent(sessionId, templateName);
    return { sessionId, agentId: agent.id };
}
