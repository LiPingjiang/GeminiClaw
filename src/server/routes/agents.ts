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
        const agentNameOverride = request.body?.agent_name ?? undefined;
        const agent = agentRepo.createMainAgent(sessionId, templateName, agentNameOverride);
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
        const validStatuses = ["active", "idle", "completed", "error", "archived"];
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
    // ── GET /v1/agents/:id/system-prompt ─────────────────────────────────────────
    // 生成 agent 完整的系统 prompt（identity + 代码常量 + workspace 记忆）
    fastify.get("/v1/agents/:id/system-prompt", async (request, reply) => {
        if (!checkAuth(request, authToken)) return reply.status(401).send({ error: "Unauthorized" });
        const agent = agentRepo.getById(request.params.id);
        if (!agent) return reply.status(404).send({ error: "Agent not found" });
        const { buildSystemPrompt } = await import("../../system-prompt/builder.js");
        const { WorkingMemoryBuilder } = await import("../../memory/working-memory.js");
        const { MemoryPaths } = await import("../../memory/paths.js");
        const paths = new MemoryPaths();
        const wm = new WorkingMemoryBuilder(paths);
        const date = new Date().toISOString().slice(0, 10);
        // Read routing config for model family detection
        const configRow = db.prepare("SELECT 1").get(); // just check db is accessible
        void configRow;
        const base = buildSystemPrompt(); // will use default routing from config
        const workspace = wm.renderSystemPrompt(agent.id, date, agent.agent_name);
        const full = workspace ? base + "\n\n---\n\n" + workspace : base;
        return reply.send({
            agentId: agent.id,
            agentName: agent.agent_name,
            systemPrompt: full,
            baseLength: base.length,
            workspaceLength: workspace.length,
        });
    });
    // ── GET /v1/skills ────────────────────────────────────────────────────────────
    // 列出项目 skills 目录下的可用技能
    fastify.get("/v1/project-skills", async (request, reply) => {
        if (!checkAuth(request, authToken)) return reply.status(401).send({ error: "Unauthorized" });
        const { existsSync, readdirSync, readFileSync, statSync } = await import("fs");
        const { join } = await import("path");
        const skillsDir = join(process.cwd(), "skills");
        if (!existsSync(skillsDir)) return reply.send({ skills: [] });
        const skills: Array<{ name: string; description: string; enabled: boolean }> = [];
        for (const entry of readdirSync(skillsDir)) {
            if (entry.startsWith(".")) continue;
            const entryPath = join(skillsDir, entry);
            try { if (!statSync(entryPath).isDirectory()) continue; } catch { continue; }
            const skillFile = join(entryPath, "SKILL.md");
            if (!existsSync(skillFile)) continue;
            const content = readFileSync(skillFile, "utf-8").trim();
            // Extract description from frontmatter
            let description = entry;
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch) {
                const descMatch = fmMatch[1].match(/description:\s*(.+)/);
                if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, "");
            }
            skills.push({ name: entry, description, enabled: true });
        }
        return reply.send({ skills });
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
