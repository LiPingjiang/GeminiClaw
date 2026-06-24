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
    const { db, authToken, routingDefault } = opts;
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
        // 默认或显式指定"双子星"时，复用全局唯一的双子星实体
        const isDefault = !agentNameOverride || agentNameOverride === "双子星";
        if (isDefault) {
            const existing = db.prepare(
                `SELECT * FROM agents WHERE agent_name = '双子星' AND depth = 0 AND status = 'active' ORDER BY created_at ASC LIMIT 1`
            ).get();
            if (existing) {
                db.prepare(`UPDATE chat_sessions SET main_agent_id = ? WHERE id = ?`).run(existing.id, sessionId);
                return reply.status(201).send({ agent: existing });
            }
        }
        const agent = agentRepo.createMainAgent(sessionId, templateName, agentNameOverride ?? "双子星");
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
        if (agent.agent_name === "双子星" && status === "archived") {
            return reply.status(403).send({ error: "双子星 is a protected agent and cannot be archived" });
        }
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
    // ── GET /v1/agents/:id/config ────────────────────────────────────────────────
    fastify.get("/v1/agents/:id/config", async (request, reply) => {
        if (!checkAuth(request, authToken)) return reply.status(401).send({ error: "Unauthorized" });
        const agent = agentRepo.getById(request.params.id);
        if (!agent) return reply.status(404).send({ error: "Agent not found" });
        const raw = (agent as any).config;
        let config = { skills: null, constants: {}, model: null };
        if (raw) {
            try { config = { ...config, ...JSON.parse(raw) }; } catch { /* ignore */ }
        }
        return reply.send({ agentId: agent.id, config });
    });
    // ── PATCH /v1/agents/:id/config ──────────────────────────────────────────────
    fastify.patch("/v1/agents/:id/config", async (request, reply) => {
        if (!checkAuth(request, authToken)) return reply.status(401).send({ error: "Unauthorized" });
        const agent = agentRepo.getById(request.params.id);
        if (!agent) return reply.status(404).send({ error: "Agent not found" });
        const body = request.body as { skills?: string[] | null; constants?: Record<string, string | null>; model?: string | null };
        // Merge with existing config
        const existing = (() => { try { return JSON.parse((agent as any).config ?? "{}") } catch { return {} } })();
        const merged = { ...existing, ...body };
        // Remove nulled-out top-level keys to keep clean
        if (merged.skills === null) merged.skills = null;  // keep null (means inherit global)
        db.prepare(`UPDATE agents SET config = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(JSON.stringify(merged), agent.id);
        return reply.send({ agentId: agent.id, config: merged });
    });
    // ── GET /v1/agents/:id/system-prompt ─────────────────────────────────────────
    // 返回 agent 系统 prompt 的结构化分层数据（各层内容 + 元信息）
    fastify.get("/v1/agents/:id/system-prompt", async (request, reply) => {
        if (!checkAuth(request, authToken)) return reply.status(401).send({ error: "Unauthorized" });
        const agent = agentRepo.getById(request.params.id);
        if (!agent) return reply.status(404).send({ error: "Agent not found" });
        const { buildSystemPrompt } = await import("../../system-prompt/builder.js");
        const { detectModelFamily } = await import("../../system-prompt/families.js");
        const {
            TOOL_USE_ENFORCEMENT, PREREQUISITE_CHECKS, GROUNDING_VERIFICATION,
            CLAUDE_MANDATORY_TOOL_USE, CLAUDE_ACT_DONT_ASK, STRICT_MANDATORY_TOOL_USE,
        } = await import("../../system-prompt/constants.js");
        const { WorkingMemoryBuilder } = await import("../../memory/working-memory.js");
        const { MemoryPaths } = await import("../../memory/paths.js");
        const { existsSync, readFileSync } = await import("fs");
        const { join } = await import("path");
        const { default: os } = await import("os");
        const model = routingDefault ?? "unknown";
        const family = detectModelFamily(model);
        const root = join(os.homedir(), ".gemeniclaw");
        const date = new Date().toISOString().slice(0, 10);
        const paths = new MemoryPaths();
        const wm = new WorkingMemoryBuilder(paths);
        const wmData = wm.build(agent.id, date);
        // Read daily memory files directly (renderSystemPrompt doesn't include globalFixed anymore)
        const globalDailyPath = join(root, "memory", "global", "daily", `${date}.md`);
        const agentDailyPath = join(root, "agents", agent.id, "daily", `${date}.md`);
        const read = (p: string) => existsSync(p) ? readFileSync(p, "utf-8").trim() : "";
        // Layer 0: code constants
        const isStrict = family !== "claude";
        const constantsLayer = [
            { name: "TOOL_USE_ENFORCEMENT", content: TOOL_USE_ENFORCEMENT, scope: "all-models" },
            { name: "PREREQUISITE_CHECKS", content: PREREQUISITE_CHECKS, scope: "all-models" },
            { name: "GROUNDING_VERIFICATION", content: GROUNDING_VERIFICATION, scope: "all-models" },
            isStrict
                ? { name: "STRICT_MANDATORY_TOOL_USE", content: STRICT_MANDATORY_TOOL_USE, scope: `model-family:${family}` }
                : { name: "CLAUDE_MANDATORY_TOOL_USE", content: CLAUDE_MANDATORY_TOOL_USE, scope: "model-family:claude" },
            ...(!isStrict ? [{ name: "CLAUDE_ACT_DONT_ASK", content: CLAUDE_ACT_DONT_ASK, scope: "model-family:claude" }] : []),
        ];
        // Layer 1: global identity
        const globalAgentMdPath = join(root, "AGENT.md");
        const globalAgentMd = read(globalAgentMdPath);
        // Layer 2: agent fixed memory
        const agentAgentMdPath = join(root, "agents", agent.id, "AGENT.md");
        const agentAgentMd = wmData.agentFixed; // already read by WorkingMemory
        // Layer 3: non-fixed memory
        const globalMemoryPath = join(root, "memory", "global", "MEMORY.md");
        const agentMemoryPath = join(root, "agents", agent.id, "MEMORY.md");
        const globalDaily = read(globalDailyPath);
        const agentDaily = read(agentDailyPath);
        // Layer 4: active topics from DB
        const activeTopics = db.prepare(`
            SELECT id, title, summary FROM memory_topics WHERE active = 1
            ORDER BY last_accessed_at DESC LIMIT 20
        `).all() as Array<{ id: string; title: string; summary: string }>;
        // Assemble full prompt for total char count
        const base = buildSystemPrompt(model);
        const workspace = wm.renderSystemPrompt(agent.id, date, agent.agent_name);
        const totalChars = base.length + (workspace ? workspace.length + 8 : 0);
        return reply.send({
            agentId: agent.id,
            agentName: agent.agent_name,
            model,
            modelFamily: family,
            totalChars,
            layers: {
                constants: {
                    label: "代码常量（不可修改，版本控制）",
                    editable: false,
                    items: constantsLayer.map(c => ({
                        name: c.name,
                        scope: c.scope,
                        chars: c.content.length,
                        content: c.content,
                    })),
                },
                globalIdentity: {
                    label: "全局身份（Config > AGENT.MD 修改）",
                    editable: true,
                    editPath: "config:agent-md",
                    file: globalAgentMdPath,
                    chars: globalAgentMd.length,
                    content: globalAgentMd,
                },
                agentFixed: {
                    label: "Agent 固定记忆（此处可修改）",
                    editable: true,
                    editPath: "agent:agent-md",
                    file: agentAgentMdPath,
                    chars: agentAgentMd.length,
                    content: agentAgentMd,
                    exists: existsSync(agentAgentMdPath),
                },
                memory: {
                    label: "非固定记忆（triage 自动管理，可手动编辑）",
                    items: [
                        { name: "全局 MEMORY.MD", file: globalMemoryPath, editable: true, editPath: "config:memory-md", chars: wmData.globalNonFixed.length, content: wmData.globalNonFixed, exists: existsSync(globalMemoryPath) },
                        { name: `全局今日记忆 (${date})`, file: globalDailyPath, editable: false, chars: globalDaily.length, content: globalDaily, exists: existsSync(globalDailyPath) },
                        { name: "Agent MEMORY.MD", file: agentMemoryPath, editable: true, editPath: "agent:memory-md", chars: agentAgentMd ? wmData.agentNonFixed.length : 0, content: wmData.agentNonFixed, exists: existsSync(agentMemoryPath) },
                        { name: `Agent 今日记忆 (${date})`, file: agentDailyPath, editable: false, chars: agentDaily.length, content: agentDaily, exists: existsSync(agentDailyPath) },
                    ],
                },
                topics: {
                    label: "话题记忆（LayeredStrategy 自动管理，只读）",
                    editable: false,
                    count: activeTopics.length,
                    items: activeTopics.map(t => ({ id: t.id, title: t.title, summary: t.summary })),
                },
            },
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
