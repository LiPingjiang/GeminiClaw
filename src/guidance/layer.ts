// src/guidance/layer.ts
import type { Db } from "../db/client.js"
import type { TemplateManager } from "../templates/manager.js"
import { AgentRepository } from "../agents/repository.js"
import { TaskRepository } from "../agents/task-repository.js"
import { createSessionWithAgent } from "../server/routes/agents.js"

export interface RouteResult {
  sessionId: string
  agentId: string
  agentName: string
  isNew: boolean
  templateName: string
}

/**
 * Tokenize a string into lowercase words (split on whitespace and CJK punctuation).
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s，。！？、；：""''【】《》（）,.!?;:()\[\]{}<>]+/)
    .filter((t) => t.length > 0)
}

/**
 * Score how well a candidate text matches the query tokens.
 * Returns the number of unique tokens found in candidate.
 */
function matchScore(queryTokens: string[], candidate: string): number {
  const lower = candidate.toLowerCase()
  let score = 0
  for (const token of queryTokens) {
    if (token.length >= 2 && lower.includes(token)) {
      score++
    }
  }
  return score
}

export class GuidanceLayer {
  private agentRepo: AgentRepository
  private taskRepo: TaskRepository

  constructor(
    agentRepo: AgentRepository,
    private templateManager: TemplateManager,
    private db: Db
  ) {
    this.agentRepo = agentRepo
    this.taskRepo = new TaskRepository(db)
  }

  /**
   * Route a user message to the best matching session.
   * Returns the sessionId, agentId, agentName, and whether it was newly created.
   */
  async route(userMessage: string, _userId: string): Promise<RouteResult> {
    const queryTokens = tokenize(userMessage)
    const activeAgents = this.agentRepo.listActiveMainAgents()

    let bestAgent = null
    let bestScore = 0

    for (const agent of activeAgents) {
      // Score against agent description
      let score = matchScore(queryTokens, agent.description ?? "")
      score += matchScore(queryTokens, agent.agent_name)

      // Score against active task titles
      const activeTasks = this.taskRepo.getActive(agent.id)
      for (const task of activeTasks) {
        score += matchScore(queryTokens, task.title)
      }

      if (score > bestScore) {
        bestScore = score
        bestAgent = agent
      }
    }

    if (bestAgent && bestScore > 0) {
      return {
        sessionId: bestAgent.session_id,
        agentId: bestAgent.id,
        agentName: bestAgent.agent_name,
        isNew: false,
        templateName: bestAgent.template_name,
      }
    }

    // No match — find or create a misc agent
    return this._getOrCreateMiscAgent()
  }

  /**
   * Find an existing misc agent (base template, agent_name starts with "杂项") or create one.
   */
  private async _getOrCreateMiscAgent(): Promise<RouteResult> {
    // Look for an existing misc session (base template, active)
    const existing = this.db
      .prepare(
        `SELECT a.* FROM agents a
         WHERE a.template_name = 'base'
           AND a.depth = 0
           AND a.status = 'active'
           AND a.agent_name LIKE '杂项%'
         ORDER BY a.created_at DESC
         LIMIT 1`
      )
      .get() as import("../agents/repository.js").Agent | undefined

    if (existing) {
      return {
        sessionId: existing.session_id,
        agentId: existing.id,
        agentName: existing.agent_name,
        isNew: false,
        templateName: existing.template_name,
      }
    }

    // Create new misc session + agent
    const { sessionId, agentId } = await createSessionWithAgent("base", this.db)
    this.agentRepo.update(agentId, {
      agent_name: "杂项助手",
      description: "处理临时杂项问题",
    })

    return {
      sessionId,
      agentId,
      agentName: "杂项助手",
      isNew: true,
      templateName: "base",
    }
  }
}
