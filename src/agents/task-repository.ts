// @ts-nocheck
// src/agents/task-repository.ts
import { randomUUID } from "crypto";
const MAX_TASK_DEPTH = 4;
export class TaskRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Create a task. If parentId is provided, inherits session from parent and depth = parent.depth + 1.
     * Throws if depth would exceed MAX_TASK_DEPTH.
     */
    create(agentId, sessionId, title, parentId) {
        const id = randomUUID();
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        let depth = 0;
        let resolvedParentId = parentId ?? null;
        if (parentId) {
            const parent = this.getById(parentId);
            if (!parent)
                throw new Error(`Parent task not found: ${parentId}`);
            if (parent.depth >= MAX_TASK_DEPTH) {
                throw new Error(`Task depth limit (${MAX_TASK_DEPTH}) reached`);
            }
            depth = parent.depth + 1;
        }
        this.db
            .prepare(`INSERT INTO tasks (id, agent_id, session_id, parent_id, title, depth, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
            .run(id, agentId, sessionId, resolvedParentId, title, depth, now, now);
        return this.getById(id);
    }
    /**
     * Update task fields.
     */
    update(id, patch) {
        const fields = [];
        const values = [];
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        if (patch.title !== undefined) {
            fields.push("title = ?");
            values.push(patch.title);
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
            .prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`)
            .run(...values);
    }
    /**
     * Get task by ID.
     */
    getById(id) {
        return (this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) ??
            null);
    }
    /**
     * Return all tasks for an agent, ordered for tree traversal (by parent_id then created_at).
     */
    getTree(agentId) {
        return this.db
            .prepare(`SELECT * FROM tasks WHERE agent_id = ? ORDER BY depth ASC, created_at ASC`)
            .all(agentId);
    }
    /**
     * Return active tasks (pending or in_progress) for an agent.
     */
    getActive(agentId) {
        return this.db
            .prepare(`SELECT * FROM tasks WHERE agent_id = ? AND status IN ('pending', 'in_progress') ORDER BY depth ASC, created_at ASC`)
            .all(agentId);
    }
}
