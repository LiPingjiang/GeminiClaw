// @ts-nocheck
// src/agents/repository.ts
import { randomUUID } from "crypto";
export class AgentRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Create the main agent for a session (depth=0, parent=null).
     * Also updates chat_sessions.main_agent_id.
     */
    createMainAgent(sessionId, templateName, agentNameOverride) {
        const id = randomUUID();
        const agentName = agentNameOverride ?? `agent-${id.slice(0, 8)}`;
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        this.db
            .prepare(`INSERT INTO agents (id, session_id, parent_agent_id, template_name, agent_name, depth, status, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, 0, 'active', ?, ?)`)
            .run(id, sessionId, templateName, agentName, now, now);
        // Update chat_sessions.main_agent_id (don't touch updated_at — session ordering tracks conversation activity)
        this.db
            .prepare(`UPDATE chat_sessions SET main_agent_id = ? WHERE id = ?`)
            .run(id, sessionId);
        return this.getById(id);
    }
    /**
     * Create a sub-agent (depth = parent.depth + 1).
     */
    createSubAgent(parentAgentId, templateName) {
        const parent = this.getById(parentAgentId);
        if (!parent)
            throw new Error(`Parent agent not found: ${parentAgentId}`);
        const id = randomUUID();
        const agentName = `agent-${id.slice(0, 8)}`;
        const depth = parent.depth + 1;
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        this.db
            .prepare(`INSERT INTO agents (id, session_id, parent_agent_id, template_name, agent_name, depth, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
            .run(id, parent.session_id, parentAgentId, templateName, agentName, depth, now, now);
        return this.getById(id);
    }
    /**
     * Get agent by ID.
     */
    getById(id) {
        return (this.db
            .prepare(`SELECT * FROM agents WHERE id = ?`)
            .get(id) ?? null);
    }
    /**
     * Get the main agent (depth=0) for a session.
     */
    getMainAgent(sessionId) {
        return (this.db
            .prepare(`SELECT * FROM agents WHERE session_id = ? AND depth = 0 ORDER BY created_at ASC LIMIT 1`)
            .get(sessionId) ?? null);
    }
    /**
     * List all active main agents (depth=0, status=active). Used by GuidanceLayer.
     */
    listActiveMainAgents() {
        return this.db
            .prepare(`SELECT * FROM agents WHERE depth = 0 AND status = 'active' ORDER BY created_at DESC`)
            .all();
    }
    /**
     * Update agent fields.
     */
    update(id, patch) {
        const fields = [];
        const values = [];
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        if (patch.agent_name !== undefined) {
            fields.push("agent_name = ?");
            values.push(patch.agent_name);
        }
        if (patch.description !== undefined) {
            fields.push("description = ?");
            values.push(patch.description);
        }
        if (patch.status !== undefined) {
            fields.push("status = ?");
            values.push(patch.status);
        }
        if (fields.length === 0)
            return;
        fields.push("updated_at = ?");
        values.push(now);
        values.push(id);
        this.db
            .prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`)
            .run(...values);
    }
}
