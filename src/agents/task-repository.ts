// src/agents/task-repository.ts
import { randomUUID } from "crypto"
import type { Db } from "../db/client.js"

export interface Task {
  id: string
  agent_id: string
  session_id: string
  parent_id: string | null
  title: string
  description: string | null
  status: "pending" | "in_progress" | "done" | "cancelled"
  depth: number
  created_at: string
  updated_at: string
}

const MAX_TASK_DEPTH = 4

export class TaskRepository {
  constructor(private db: Db) {}

  /**
   * Create a task. If parentId is provided, inherits session from parent and depth = parent.depth + 1.
   * Throws if depth would exceed MAX_TASK_DEPTH.
   */
  create(agentId: string, sessionId: string, title: string, parentId?: string): Task {
    const id = randomUUID()
    const now = new Date().toISOString().replace("T", " ").slice(0, 19)

    let depth = 0
    let resolvedParentId: string | null = parentId ?? null

    if (parentId) {
      const parent = this.getById(parentId)
      if (!parent) throw new Error(`Parent task not found: ${parentId}`)
      if (parent.depth >= MAX_TASK_DEPTH) {
        throw new Error(`Task depth limit (${MAX_TASK_DEPTH}) reached`)
      }
      depth = parent.depth + 1
    }

    this.db
      .prepare(
        `INSERT INTO tasks (id, agent_id, session_id, parent_id, title, depth, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(id, agentId, sessionId, resolvedParentId, title, depth, now, now)

    return this.getById(id)!
  }

  /**
   * Update task fields.
   */
  update(
    id: string,
    patch: Partial<Pick<Task, "title" | "description" | "status">>
  ): void {
    const fields: string[] = []
    const values: unknown[] = []
    const now = new Date().toISOString().replace("T", " ").slice(0, 19)

    if (patch.title !== undefined) {
      fields.push("title = ?")
      values.push(patch.title)
    }
    if (patch.description !== undefined) {
      fields.push("description = ?")
      values.push(patch.description)
    }
    if (patch.status !== undefined) {
      fields.push("status = ?")
      values.push(patch.status)
    }
    if (fields.length === 0) return

    fields.push("updated_at = ?")
    values.push(now)
    values.push(id)

    this.db
      .prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values)
  }

  /**
   * Get task by ID.
   */
  getById(id: string): Task | null {
    return (
      (this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Task | undefined) ??
      null
    )
  }

  /**
   * Return all tasks for an agent, ordered for tree traversal (by parent_id then created_at).
   */
  getTree(agentId: string): Task[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE agent_id = ? ORDER BY depth ASC, created_at ASC`
      )
      .all(agentId) as Task[]
  }

  /**
   * Return active tasks (pending or in_progress) for an agent.
   */
  getActive(agentId: string): Task[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE agent_id = ? AND status IN ('pending', 'in_progress') ORDER BY depth ASC, created_at ASC`
      )
      .all(agentId) as Task[]
  }
}
