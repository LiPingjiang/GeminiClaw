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
 * Detect if a message expresses intent to create/switch to a new named agent.
 * Returns the proposed agent name, or null if not a creation request.
 */
function detectAgentCreation(msg: string): string | null {
  const hasCreationVerb = /搞一个|新建|创建|建一个|弄一个|换一个|换个|专门搞/.test(msg)
  const hasAgentNoun = /[Aa]gent|\u52a9\u624b|\u4e13\u5bb6/.test(msg)
  if (!hasCreationVerb || !hasAgentNoun) return null

  // Try to extract name after 叫/叫做/叫作
  const nameMatch =
    msg.match(/\u53eb(?:\u505a|\u4f5c)?([A-Za-z\u4e00-\u9fa5\s]{2,30}?)(?:[\uff0c\u3002\uff01\u5427\s]|$)/) ??
    msg.match(/([A-Z][a-zA-Z\s]+(?:Agent|\u52a9\u624b|\u4e13\u5bb6))/)
  const name = nameMatch?.[1]?.trim()
  return name && name.length >= 2 ? name : '\u65b0\u52a9\u624b'
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
 * Checks if each token appears in the candidate (forward match).
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

/**
 * Reverse match: split candidate into tokens, check if message contains each token.
 * Used for Chinese where keywords are short and messages are long unsplit strings.
 */
function matchScoreReverse(msgLower: string, candidate: string): number {
  const tokens = tokenize(candidate)
  let score = 0
  for (const token of tokens) {
    if (token.length >= 2 && msgLower.includes(token)) {
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

  /** Persist current session for a user (sticky). */
  setUserSession(openid: string, result: RouteResult): void {
    this.db
      .prepare(
        `INSERT INTO user_sessions (openid, session_id, agent_id, agent_name, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(openid) DO UPDATE SET
           session_id = excluded.session_id,
           agent_id   = excluded.agent_id,
           agent_name = excluded.agent_name,
           updated_at = excluded.updated_at`
      )
      .run(openid, result.sessionId, result.agentId, result.agentName, Date.now())
  }

  /** Clear sticky session for a user (called on /new). */
  clearUserSession(openid: string): void {
    this.db.prepare(`DELETE FROM user_sessions WHERE openid = ?`).run(openid)
  }

  /**
   * Route a user message to the best matching session.
   * Strategy: sticky first → active agent match → template match → misc fallback.
   */
  async route(userMessage: string, userId: string): Promise<RouteResult> {
    // ── 0. Agent creation intent: break sticky if user wants a new named agent ─
    const newAgentName = detectAgentCreation(userMessage)
    if (newAgentName) {
      this.clearUserSession(userId)
      const { sessionId, agentId } = await createSessionWithAgent('base', this.db)
      this.agentRepo.update(agentId, {
        agent_name: newAgentName,
        description: `用户创建的专用助手：${newAgentName}`,
      })
      const result: RouteResult = {
        sessionId,
        agentId,
        agentName: newAgentName,
        isNew: true,
        templateName: 'base',
      }
      this.setUserSession(userId, result)
      return result
    }

    // ── 1. Sticky session: reuse current conversation if active ──────────────
    const sticky = this.db
      .prepare(`SELECT * FROM user_sessions WHERE openid = ?`)
      .get(userId) as { session_id: string; agent_id: string; agent_name: string } | undefined

    if (sticky) {
      const agent = this.agentRepo.getById(sticky.agent_id)
      if (agent && agent.status === "active") {
        return {
          sessionId: sticky.session_id,
          agentId:   sticky.agent_id,
          agentName: sticky.agent_name,
          isNew:     false,
          templateName: agent.template_name,
        }
      }
      // Stale sticky — clean it up
      this.clearUserSession(userId)
    }

    // ── 2. Fresh routing ──────────────────────────────────────────────────────
    const queryTokens = tokenize(userMessage)
    const msgLower = userMessage.toLowerCase()
    const activeAgents = this.agentRepo.listActiveMainAgents()

    let bestAgent = null
    let bestScore = 0

    for (const agent of activeAgents) {
      // Score against agent description
      let score = matchScore(queryTokens, agent.description ?? "")
      score += matchScore(queryTokens, agent.agent_name)
      // Also check if message contains description keywords (Chinese bidirectional)
      score += matchScoreReverse(msgLower, agent.description ?? "")

      // Score against active task titles
      const activeTasks = this.taskRepo.getActive(agent.id)
      for (const task of activeTasks) {
        score += matchScore(queryTokens, task.title)
        score += matchScoreReverse(msgLower, task.title)
      }

      if (score > bestScore) {
        bestScore = score
        bestAgent = agent
      }
    }

    if (bestAgent && bestScore > 0) {
      const result: RouteResult = {
        sessionId: bestAgent.session_id,
        agentId: bestAgent.id,
        agentName: bestAgent.agent_name,
        isNew: false,
        templateName: bestAgent.template_name,
      }
      this.setUserSession(userId, result)
      return result
    }

    // No active agent matched — try template matching
    const templateMatch = await this._matchTemplate(msgLower)
    if (templateMatch) {
      this.setUserSession(userId, templateMatch)
      return templateMatch
    }

    // No match — find or create a misc agent
    const miscResult = await this._getOrCreateMiscAgent()
    this.setUserSession(userId, miscResult)
    return miscResult
  }

  /**
   * Try to match a non-base template by keywords/description.
   * If matched, create a new agent from that template.
   */
  private async _matchTemplate(msgLower: string): Promise<RouteResult | null> {
    const templates = this.templateManager.list()
    let bestTemplate = null
    let bestScore = 0

    for (const tpl of templates) {
      if (tpl.name === "base") continue // base is misc fallback
      // Check if message contains any of the template keywords
      let score = matchScoreReverse(msgLower, tpl.description ?? "")
      score += matchScoreReverse(msgLower, tpl.display_name ?? "")
      for (const kw of tpl.keywords ?? []) {
        if (kw.length >= 2 && msgLower.includes(kw.toLowerCase())) {
          score += 2 // keywords carry more weight
        }
      }
      if (score > bestScore) {
        bestScore = score
        bestTemplate = tpl
      }
    }

    if (!bestTemplate || bestScore === 0) return null

    // Create new agent from matched template
    const { sessionId, agentId } = await createSessionWithAgent(bestTemplate.name, this.db)
    const agentName = bestTemplate.display_name ?? bestTemplate.name
    this.agentRepo.update(agentId, {
      agent_name: agentName,
      description: bestTemplate.description ?? "",
    })

    return {
      sessionId,
      agentId,
      agentName,
      isNew: true,
      templateName: bestTemplate.name,
    }
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
