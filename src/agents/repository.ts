// src/agents/repository.ts
import { randomUUID } from "crypto"
import type { Db } from "../db/client.js"

export interface Agent {
  id: string
  session_id: string
  parent_agent_id: string | null
  template_name: string
  agent_name: string
  description: string | null
  depth: number
  status: "active" | "idle" | "completed" | "error"
  created_at: string
  updated_at: string
}

export class AgentRepository {
  constructor(private db: Db) {}

  /**
   * Create the main agent for a session (depth=0, parent=null).
   * Also updates chat_sessions.main_agent_id.
   */
  createMainAgent(sessionId: string, templateName: string): Agent {
    const id = randomUUID()
    const agentName = `agent-${id.slice(0, 8)}`
    const now = new Date().toISOString().replace("T", " ").slice(0, 19)

    this.db
      .prepare(
        `INSERT INTO agents (id, session_id, parent_agent_id, template_name, agent_name, depth, status, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, 0, 'active', ?, ?)`
      )
      .run(id, sessionId, templateName, agentName, now, now)

    // Update chat_sessions.main_agent_id
    this.db
      .prepare(`UPDATE chat_sessions SET main_agent_id = ?, updated_at = ? WHERE id = ?`)
      .run(id, now, sessionId)

    return this.getById(id)!
  }

  /**
   * Create a sub-agent (depth = parent.depth + 1).
   */
  createSubAgent(parentAgentId: string, templateName: string): Agent {
    const parent = this.getById(parentAgentId)
    if (!parent) throw new Error(`Parent agent not found: ${parentAgentId}`)

    const id = randomUUID()
    const agentName = `agent-${id.slice(0, 8)}`
    const depth = parent.depth + 1
    const now = new Date().toISOString().replace("T", " ").slice(0, 19)

    this.db
      .prepare(
        `INSERT INTO agents (id, session_id, parent_agent_id, template_name, agent_name, depth, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(id, parent.session_id, parentAgentId, templateName, agentName, depth, now, now)

    return this.getById(id)!
  }

  /**
   * Get agent by ID.
   */
  getById(id: string): Agent | null {
    return (
      (this.db
        .prepare(`SELECT * FROM agents WHERE id = ?`)
        .get(id) as Agent | undefined) ?? null
    )
  }

  /**
   * Get the main agent (depth=0) for a session.
   */
  getMainAgent(sessionId: string): Agent | null {
    return (
      (this.db
        .prepare(`SELECT * FROM agents WHERE session_id = ? AND depth = 0 ORDER BY created_at ASC LIMIT 1`)
        .get(sessionId) as Agent | undefined) ?? null
    )
  }

  /**
   * List all active main agents (depth=0, status=active). Used by GuidanceLayer.
   */
  listActiveMainAgents(): Agent[] {
    return this.db
      .prepare(`SELECT * FROM agents WHERE depth = 0 AND status = 'active' ORDER BY created_at DESC`)
      .all() as Agent[]
  }

  /**
   * Update agent fields.
   */
  update(
    id: string,
    patch: Partial<Pick<Agent, "agent_name" | "description" | "status">>
  ): void {
    const fields: string[] = []
    const values: unknown[] = []
    const now = new Date().toISOString().replace("T", " ").slice(0, 19)

    if (patch.agent_name !== undefined) {
      fields.push("agent_name = ?")
      values.push(patch.agent_name)
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
      .prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values)
  }
}
