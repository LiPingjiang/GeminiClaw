// src/guidance/layer.ts
import type { Db } from "../db/client.js";
import type { TemplateManager } from "../templates/manager.js";
import { AgentRepository } from "../agents/repository.js";
import { TaskRepository } from "../agents/task-repository.js";
import { createSessionWithAgent } from "../server/routes/agents.js";

export interface RouteResult {
  sessionId: string;
  agentId: string;
  agentName: string;
  isNew: boolean;
  templateName: string;
}

function extractAgentName(msg: string): string | null {
  const afterJiao = msg.match(
    /叫(?:做|作)?([A-Za-z\u4e00-\u9fa5]{2,20}?)(?:[，。！吧\s]|$)/,
  );
  if (afterJiao?.[1]?.trim()) return afterJiao[1].trim();
  const chineseAgent = msg.match(/([\u4e00-\u9fa5]{2,8})[Aa]gent/);
  if (chineseAgent?.[1]) return chineseAgent[1] + "Agent";
  const chineseSuffix = msg.match(/([\u4e00-\u9fa5]{2,8})(助手|专家)/);
  if (chineseSuffix?.[1]) return chineseSuffix[1] + chineseSuffix[2];
  const english = msg.match(
    /([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)*\s*(?:Agent|助手|专家)?)/,
  );
  const englishName = english?.[1]?.trim();
  if (englishName && englishName.length >= 3) return englishName;
  return null;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s，。！？、；：""''【】《》（）,.!?;:()\[\]{}<>]+/)
    .filter((t) => t.length > 0);
}

function matchScore(queryTokens: string[], candidate: string): number {
  const lower = candidate.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (token.length >= 2 && lower.includes(token)) {
      score++;
    }
  }
  return score;
}

function matchScoreReverse(msgLower: string, candidate: string): number {
  const tokens = tokenize(candidate);
  let score = 0;
  for (const token of tokens) {
    if (token.length >= 2 && msgLower.includes(token)) {
      score++;
    }
  }
  return score;
}

export class GuidanceLayer {
  private templateManager: TemplateManager;
  private db: Db;
  private agentRepo: AgentRepository;
  private taskRepo: TaskRepository;

  constructor(
    agentRepo: AgentRepository,
    templateManager: TemplateManager,
    db: Db,
  ) {
    this.templateManager = templateManager;
    this.db = db;
    this.agentRepo = agentRepo;
    this.taskRepo = new TaskRepository(db);
  }

  setUserSession(openid: string, result: RouteResult): void {
    this.db
      .prepare(
        `INSERT INTO user_sessions (openid, session_id, agent_id, agent_name, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(openid) DO UPDATE SET
           session_id = excluded.session_id,
           agent_id   = excluded.agent_id,
           agent_name = excluded.agent_name,
           updated_at = excluded.updated_at`,
      )
      .run(
        openid,
        result.sessionId,
        result.agentId,
        result.agentName,
        Date.now(),
      );
  }

  clearUserSession(openid: string): void {
    this.db
      .prepare(`DELETE FROM user_sessions WHERE openid = ?`)
      .run(openid);
  }

  async route(userMessage: string, userId: string): Promise<RouteResult> {
    // ── 1. Sticky session ──────────────────────────────────────────────────
    const sticky = this.db
      .prepare(`SELECT * FROM user_sessions WHERE openid = ?`)
      .get(userId) as {
      session_id: string;
      agent_id: string;
      agent_name: string;
    } | undefined;
    if (sticky) {
      const agent = this.agentRepo.getById(sticky.agent_id);
      if (agent && (agent as { status: string }).status === "active") {
        return {
          sessionId: sticky.session_id,
          agentId: sticky.agent_id,
          agentName: sticky.agent_name,
          isNew: false,
          templateName: (agent as { template_name: string }).template_name,
        };
      }
      this.clearUserSession(userId);
    }

    // ── 2. Fresh routing ──────────────────────────────────────────────────
    const queryTokens = tokenize(userMessage);
    const msgLower = userMessage.toLowerCase();
    const activeAgents = this.agentRepo.listActiveMainAgents() as Array<{
      id: string;
      agent_name: string;
      session_id: string;
      template_name: string;
      description?: string;
    }>;
    let bestAgent: (typeof activeAgents)[0] | null = null;
    let bestScore = 0;

    for (const agent of activeAgents) {
      let score = matchScore(queryTokens, agent.description ?? "");
      score += matchScore(queryTokens, agent.agent_name);
      score += matchScoreReverse(msgLower, agent.description ?? "");
      const activeTasks = this.taskRepo.getActive(agent.id) as Array<{
        title: string;
      }>;
      for (const task of activeTasks) {
        score += matchScore(queryTokens, task.title);
        score += matchScoreReverse(msgLower, task.title);
      }
      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent;
      }
    }

    if (bestAgent && bestScore > 0) {
      const result: RouteResult = {
        sessionId: bestAgent.session_id,
        agentId: bestAgent.id,
        agentName: bestAgent.agent_name,
        isNew: false,
        templateName: bestAgent.template_name,
      };
      this.setUserSession(userId, result);
      return result;
    }

    const templateMatch = await this._matchTemplate(msgLower);
    if (templateMatch) {
      this.setUserSession(userId, templateMatch);
      return templateMatch;
    }

    const miscResult = await this._getOrCreateMiscAgent();
    this.setUserSession(userId, miscResult);
    return miscResult;
  }

  private async _matchTemplate(msgLower: string): Promise<RouteResult | null> {
    const templates = this.templateManager.list() as Array<{
      name: string;
      description?: string;
      display_name?: string;
      keywords?: string[];
    }>;
    let bestTemplate: (typeof templates)[0] | null = null;
    let bestScore = 0;

    for (const tpl of templates) {
      if (tpl.name === "base") continue;
      let score = matchScoreReverse(msgLower, tpl.description ?? "");
      score += matchScoreReverse(msgLower, tpl.display_name ?? "");
      for (const kw of tpl.keywords ?? []) {
        if (kw.length >= 2 && msgLower.includes(kw.toLowerCase())) {
          score += 2;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestTemplate = tpl;
      }
    }

    if (!bestTemplate || bestScore === 0) return null;

    // ── Dedup: reuse existing active agent for this template ──
    const existingAgent = this.agentRepo.findActiveByTemplate(bestTemplate.name);
    if (existingAgent) {
      this.agentRepo.update(existingAgent.id, {}); // refresh updated_at
      return {
        sessionId: existingAgent.session_id,
        agentId: existingAgent.id,
        agentName: existingAgent.agent_name,
        isNew: false,
        templateName: existingAgent.template_name,
      };
    }

    const { sessionId, agentId } = await createSessionWithAgent(
      bestTemplate.name,
      this.db,
    );
    const agentName = bestTemplate.display_name ?? bestTemplate.name;
    this.agentRepo.update(agentId, {
      agent_name: agentName,
      description: bestTemplate.description ?? "",
    });
    return {
      sessionId,
      agentId,
      agentName,
      isNew: true,
      templateName: bestTemplate.name,
    };
  }

  private async _getOrCreateMiscAgent(): Promise<RouteResult> {
    const existing = this.db
      .prepare(
        `SELECT a.* FROM agents a
         WHERE a.template_name = 'base'
           AND a.depth = 0
           AND a.status = 'active'
           AND a.agent_name LIKE '杂项%'
         ORDER BY a.created_at DESC
         LIMIT 1`,
      )
      .get() as {
      session_id: string;
      id: string;
      agent_name: string;
      template_name: string;
    } | undefined;

    if (existing) {
      return {
        sessionId: existing.session_id,
        agentId: existing.id,
        agentName: existing.agent_name,
        isNew: false,
        templateName: existing.template_name,
      };
    }

    const { sessionId, agentId } = await createSessionWithAgent("base", this.db);
    this.agentRepo.update(agentId, {
      agent_name: "杂项助手",
      description: "处理临时杂项问题",
    });
    return {
      sessionId,
      agentId,
      agentName: "杂项助手",
      isNew: true,
      templateName: "base",
    };
  }
}
