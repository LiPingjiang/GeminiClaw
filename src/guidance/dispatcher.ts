// @ts-nocheck
// src/guidance/dispatcher.ts
// DispatcherAgent: An LLM-powered routing layer that decides which agent should handle each message.
// Every message goes through LLM judgment — no sticky fast-path bypass.

import type { Db } from "../db/client.js";
import type { ProviderRouter } from "../providers/router.js";
import { AgentRepository } from "../agents/repository.js";
import { createSessionWithAgent } from "../server/routes/agents.js";
import type { TemplateManager } from "../templates/manager.js";

export interface RouteResult {
  sessionId: string;
  agentId: string;
  agentName: string;
  isNew: boolean;
  templateName: string;
}

interface AgentStatus {
  id: string;
  name: string;
  description: string;
  templateName: string;
  sessionId: string;
  lastActivity: string;
  recentMessages: string[];  // last 2-3 messages summary
  isBusy: boolean;
}

interface DispatchDecision {
  action: "route_existing" | "create_new" | "queue";
  targetAgentId?: string;
  newAgentName?: string;
  newAgentDescription?: string;
  newAgentTemplate?: string;
  reason?: string;
}

/** Map of agentId -> busy state (true = currently processing) */
const agentBusyMap = new Map<string, boolean>();
/** Queue: messages waiting for a busy agent */
const messageQueue = new Map<string, Array<{ resolve: (v: RouteResult) => void; userId: string; message: string }>>();

export class DispatcherAgent {
  private db: Db;
  private router: ProviderRouter;
  private agentRepo: AgentRepository;
  private templateManager: TemplateManager;
  private model?: string; // configurable dispatcher model

  constructor(params: {
    db: Db;
    router: ProviderRouter;
    agentRepo: AgentRepository;
    templateManager: TemplateManager;
    model?: string;
  }) {
    this.db = params.db;
    this.router = params.router;
    this.agentRepo = params.agentRepo;
    this.templateManager = params.templateManager;
    this.model = params.model;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Mark an agent as busy (called before AgentLoop.run) */
  markBusy(agentId: string): void {
    agentBusyMap.set(agentId, true);
  }

  /** Mark an agent as idle (called after AgentLoop.run completes) */
  markIdle(agentId: string): void {
    agentBusyMap.set(agentId, false);
    // Process queued messages for this agent
    this._drainQueue(agentId);
  }

  /** Clear user's sticky session (for /new command) */
  clearUserSession(openid: string): void {
    this.db.prepare(`DELETE FROM user_sessions WHERE openid = ?`).run(openid);
  }

  /**
   * Route a user message to the correct agent session.
   * Every message goes through LLM judgment for accurate routing.
   */
  async route(userMessage: string, userId: string): Promise<RouteResult> {
    // ── Always use LLM to make routing decision ────────────────────────────
    const context = this._buildContext(userId);
    const decision = await this._askLLM(userMessage, context);

    console.log(`[Dispatcher] "${userMessage.slice(0, 30)}" → ${decision.action} ${decision.targetAgentId || decision.newAgentName || ""} (${decision.reason || ""})`);

    // ── Execute decision ───────────────────────────────────────────────────
    return this._executeDecision(decision, userId, userMessage);
  }

  // ── Private methods ─────────────────────────────────────────────────────

  private _getSticky(userId: string): {
    sessionId: string;
    agentId: string;
    agentName: string;
    templateName: string;
    updatedAt: number;
  } | null {
    const row = this.db
      .prepare(`SELECT us.*, a.template_name FROM user_sessions us JOIN agents a ON a.id = us.agent_id WHERE us.openid = ?`)
      .get(userId) as any;
    if (!row) return null;
    const agent = this.agentRepo.getById(row.agent_id) as any;
    if (!agent || agent.status !== "active") return null;
    return {
      sessionId: row.session_id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      templateName: agent.template_name,
      updatedAt: row.updated_at,
    };
  }

  private _touchSticky(userId: string): void {
    this.db
      .prepare(`UPDATE user_sessions SET updated_at = ? WHERE openid = ?`)
      .run(Date.now(), userId);
  }

  private _setSticky(userId: string, result: RouteResult): void {
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
      .run(userId, result.sessionId, result.agentId, result.agentName, Date.now());
  }

  private _buildContext(userId: string): {
    agents: AgentStatus[];
    userRecentMessages: string[];
    templates: Array<{ name: string; displayName: string; description: string }>;
    lastRoutedAgentId: string | null;
  } {
    // 1. Active agents with their recent messages
    const activeAgents = this.agentRepo.listActiveMainAgents() as Array<any>;
    const agents: AgentStatus[] = activeAgents.map((a) => {
      // Get last 3 messages for this agent's session
      const recentMsgs = this.db
        .prepare(
          `SELECT role, substr(content, 1, 120) as content FROM chat_messages
           WHERE session_id = ? AND role IN ('user', 'assistant') AND content != ''
           ORDER BY id DESC LIMIT 3`,
        )
        .all(a.session_id) as Array<{ role: string; content: string }>;

      return {
        id: a.id,
        name: a.agent_name,
        description: a.description || "",
        templateName: a.template_name,
        sessionId: a.session_id,
        lastActivity: a.updated_at,
        recentMessages: recentMsgs.reverse().map((m) => `[${m.role}] ${m.content}`),
        isBusy: agentBusyMap.get(a.id) || false,
      };
    });

    // 2. User's recent messages (across all sessions)
    const userMsgs = this.db
      .prepare(
        `SELECT substr(content, 1, 80) as content, session_id FROM chat_messages
         WHERE role = 'user' AND content != ''
         ORDER BY id DESC LIMIT 5`,
      )
      .all() as Array<{ content: string; session_id: string }>;

    // 3. Available templates
    const templates = (this.templateManager.list() as Array<any>).map((t) => ({
      name: t.name,
      displayName: t.display_name || t.name,
      description: t.description || "",
    }));

    // 4. Last routed agent (sticky info — used as hint, not as bypass)
    const sticky = this._getSticky(userId);
    const lastRoutedAgentId = sticky?.agentId || null;

    return {
      agents,
      userRecentMessages: userMsgs.map((m) => m.content),
      templates,
      lastRoutedAgentId,
    };
  }

  private async _askLLM(
    userMessage: string,
    context: ReturnType<typeof this._buildContext>,
  ): Promise<DispatchDecision> {
    const { agents, userRecentMessages, templates, lastRoutedAgentId } = context;

    const agentSummary = agents.length === 0
      ? "（当前没有活跃的 Agent）"
      : agents
          .map((a, i) => {
            const status = a.isBusy ? "🔴 忙碌中" : "🟢 空闲";
            const isLast = a.id === lastRoutedAgentId ? " ← 用户上一条消息路由到这里" : "";
            const msgs = a.recentMessages.length > 0
              ? `\n    最近对话: ${a.recentMessages.join(" → ")}`
              : "";
            return `  ${i + 1}. [${a.id}] ${a.name} (${status})${isLast}\n    职责: ${a.description}${msgs}`;
          })
          .join("\n");

    const templateSummary = templates
      .filter((t) => t.name !== "base")
      .map((t) => `  - ${t.name}: ${t.displayName} — ${t.description}`)
      .join("\n");

    const userHistory = userRecentMessages.length > 0
      ? `用户最近消息: ${userRecentMessages.join(" | ")}`
      : "（无历史消息）";

    const prompt = `你是一个消息调度器。你的唯一任务是决定一条新消息应该被哪个 Agent 处理。

当前活跃 Agent:
${agentSummary}

可用模板（用于创建新 Agent）:
${templateSummary || "  （无额外模板）"}

${userHistory}

---

新消息: "${userMessage}"

---

判断规则（按优先级）:
1. 如果新消息明显是在继续某个 Agent 正在做的事情（比如跟进、补充、追问、"继续"、"执行"等），路由到那个 Agent
2. 如果新消息的主题与某个空闲 Agent 的职责高度相关，路由到它
3. 如果新消息的主题与某个忙碌 Agent 相关，回复 "queue" 让消息排队等它
4. 日常闲聊、简单问答、通用计算，路由到「杂项助手」
5. 只有当消息话题与所有现有 Agent 都不相关、且现有 Agent 也无法处理时，才创建新 Agent

注意："← 用户上一条消息路由到这里" 标记表示用户上一次对话的 Agent。如果新消息像是追问/继续/指令（如"你来执行"、"继续"、"好的"），优先路由到上次的 Agent。

请严格只输出一行 JSON，不要有 markdown 格式或其他文字:
{"action": "route_existing", "targetAgentId": "实际的agent id", "reason": "简短原因"}
{"action": "queue", "targetAgentId": "实际的agent id", "reason": "简短原因"}
{"action": "create_new", "newAgentName": "名称", "newAgentDescription": "职责", "newAgentTemplate": "base", "reason": "简短原因"}`;

    try {
      const response = await this.router.chat(
        [{ role: "user", content: prompt }],
        this.model ? { model: this.model } : undefined,
      );

      const text = typeof response.content === "string"
        ? response.content
        : (response.content as Array<any>).map((b: any) => b.text || "").join("");

      // Parse JSON from response (handle markdown code blocks and various formats)
      const jsonMatch = text.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) {
        console.warn("[Dispatcher] LLM returned non-JSON:", text.slice(0, 100));
        return this._fallbackDecision(agents, lastRoutedAgentId);
      }

      const raw = JSON.parse(jsonMatch[0]);

      // Normalize: models sometimes use different field names
      const decision: DispatchDecision = this._normalizeDecision(raw, agents);
      return decision;
    } catch (err) {
      console.error("[Dispatcher] LLM call failed:", (err as Error).message);
      return this._fallbackDecision(agents, lastRoutedAgentId);
    }
  }

  /** Normalize LLM response to standard DispatchDecision format */
  private _normalizeDecision(raw: Record<string, any>, agents: AgentStatus[]): DispatchDecision {
    // Handle various action field names
    const action = raw.action || raw.decision || "route_existing";
    const reason = raw.reason || "";

    // Handle "route_existing" or "route" or similar
    if (action === "route_existing" || action === "route" || action === "route_to") {
      const targetId = raw.targetAgentId || raw.target_agent_id || raw.target || raw.route_to || raw.agentId;
      // Validate targetId exists in active agents
      const validAgent = agents.find((a) => a.id === targetId);
      if (validAgent) {
        return { action: "route_existing", targetAgentId: targetId, reason };
      }
      // Try matching by name if ID doesn't match
      const nameMatch = agents.find((a) =>
        a.name === targetId || a.id.startsWith(targetId)
      );
      if (nameMatch) {
        return { action: "route_existing", targetAgentId: nameMatch.id, reason };
      }
      // Fallback to first agent
      console.warn(`[Dispatcher] targetAgentId "${targetId}" not found in active agents`);
      return { action: "route_existing", targetAgentId: agents[0]?.id, reason };
    }

    if (action === "queue") {
      const targetId = raw.targetAgentId || raw.target_agent_id || raw.target || raw.route_to;
      return { action: "queue", targetAgentId: targetId, reason };
    }

    if (action === "create_new" || action === "create") {
      return {
        action: "create_new",
        newAgentName: raw.newAgentName || raw.name || "新助手",
        newAgentDescription: raw.newAgentDescription || raw.description || "",
        newAgentTemplate: raw.newAgentTemplate || raw.template || "base",
        reason,
      };
    }

    // Unknown action — treat as route to first agent
    console.warn(`[Dispatcher] Unknown action: "${action}"`);
    return { action: "route_existing", targetAgentId: agents[0]?.id, reason };
  }

  /** Fallback when LLM fails: prefer last routed agent, else first active */
  private _fallbackDecision(agents: AgentStatus[], lastRoutedAgentId: string | null): DispatchDecision {
    if (lastRoutedAgentId) {
      const lastAgent = agents.find((a) => a.id === lastRoutedAgentId);
      if (lastAgent) {
        return { action: "route_existing", targetAgentId: lastRoutedAgentId, reason: "LLM fallback: 使用上次路由的 Agent" };
      }
    }
    if (agents.length > 0) {
      return { action: "route_existing", targetAgentId: agents[0].id, reason: "LLM fallback: 使用第一个活跃 Agent" };
    }
    return { action: "create_new", newAgentName: "杂项助手", newAgentDescription: "处理日常对话和临时任务", newAgentTemplate: "base", reason: "LLM fallback: 无活跃 Agent" };
  }

  private async _executeDecision(
    decision: DispatchDecision,
    userId: string,
    userMessage: string,
  ): Promise<RouteResult> {
    if (decision.action === "route_existing" && decision.targetAgentId) {
      const agent = this.agentRepo.getById(decision.targetAgentId) as any;
      if (agent && agent.status === "active") {
        const result: RouteResult = {
          sessionId: agent.session_id,
          agentId: agent.id,
          agentName: agent.agent_name,
          isNew: false,
          templateName: agent.template_name,
        };
        this._setSticky(userId, result);
        return result;
      }
    }

    if (decision.action === "queue" && decision.targetAgentId) {
      // Agent is busy — put message in queue and wait
      return new Promise<RouteResult>((resolve) => {
        const queue = messageQueue.get(decision.targetAgentId!) || [];
        queue.push({ resolve, userId, message: userMessage });
        messageQueue.set(decision.targetAgentId!, queue);
      });
    }

    if (decision.action === "create_new") {
      const template = decision.newAgentTemplate || "base";
      const name = decision.newAgentName || "新助手";
      const description = decision.newAgentDescription || "";

      const { sessionId, agentId } = await createSessionWithAgent(template, this.db);
      this.agentRepo.update(agentId, { agent_name: name, description });

      const result: RouteResult = {
        sessionId,
        agentId,
        agentName: name,
        isNew: true,
        templateName: template,
      };
      this._setSticky(userId, result);
      return result;
    }

    // Fallback: get or create misc agent
    return this._getOrCreateDefault(userId);
  }

  private async _getOrCreateDefault(userId: string): Promise<RouteResult> {
    const existing = this.db
      .prepare(
        `SELECT a.* FROM agents a
         WHERE a.depth = 0 AND a.status = 'active'
         ORDER BY a.updated_at DESC
         LIMIT 1`,
      )
      .get() as any;

    if (existing) {
      const result: RouteResult = {
        sessionId: existing.session_id,
        agentId: existing.id,
        agentName: existing.agent_name,
        isNew: false,
        templateName: existing.template_name,
      };
      this._setSticky(userId, result);
      return result;
    }

    const { sessionId, agentId } = await createSessionWithAgent("base", this.db);
    this.agentRepo.update(agentId, { agent_name: "杂项助手", description: "处理日常对话和临时任务" });
    const result: RouteResult = {
      sessionId,
      agentId,
      agentName: "杂项助手",
      isNew: true,
      templateName: "base",
    };
    this._setSticky(userId, result);
    return result;
  }

  private _drainQueue(agentId: string): void {
    const queue = messageQueue.get(agentId);
    if (!queue || queue.length === 0) return;

    // Process the first queued message
    const item = queue.shift()!;
    if (queue.length === 0) messageQueue.delete(agentId);

    const agent = this.agentRepo.getById(agentId) as any;
    if (agent && agent.status === "active") {
      const result: RouteResult = {
        sessionId: agent.session_id,
        agentId: agent.id,
        agentName: agent.agent_name,
        isNew: false,
        templateName: agent.template_name,
      };
      this._setSticky(item.userId, result);
      item.resolve(result);
    }
  }
}
