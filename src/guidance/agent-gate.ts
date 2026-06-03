// src/guidance/agent-gate.ts
// AgentGate: Lightweight busy-detection + user-choice routing.
// Replaces the LLM-based DispatcherAgent with a simple model:
//   - Each user has ONE primary agent (sticky session)
//   - If that agent is idle → route directly
//   - If busy → show inline keyboard asking user to queue or spawn new agent
//
// No LLM calls. User decides.

import type { Db } from "../db/client.js";
import { AgentRepository } from "../agents/repository.js";
import { createSessionWithAgent } from "../server/routes/agents.js";

export interface GateResult {
  sessionId: string;
  agentId: string;
  agentName: string;
  isNew: boolean;
}

export interface BusyInfo {
  agentId: string;
  agentName: string;
  currentWork: string; // what the agent is doing
}

/** Map of agentId -> busy state */
const busyMap = new Map<string, boolean>();
/** Map of agentId -> current work description */
const workMap = new Map<string, string>();
/** Queue: messages waiting for a busy agent to become idle */
const waitQueue = new Map<
  string, // agentId
  Array<{
    resolve: (result: GateResult) => void;
    userId: string;
    message: string;
  }>
>();

export class AgentGate {
  private db: Db;
  private agentRepo: AgentRepository;
  private maxAgents: number;

  constructor(params: { db: Db; agentRepo: AgentRepository; maxAgents?: number }) {
    this.db = params.db;
    this.agentRepo = params.agentRepo;
    this.maxAgents = params.maxAgents ?? 5;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Check if the user's current agent is busy.
   * Returns null if idle (can proceed), or BusyInfo if occupied.
   */
  checkBusy(userId: string): BusyInfo | null {
    const sticky = this._getSticky(userId);
    if (!sticky) return null; // no agent yet, will create one

    const isBusy = busyMap.get(sticky.agentId) || false;
    if (!isBusy) return null;

    return {
      agentId: sticky.agentId,
      agentName: sticky.agentName,
      currentWork: workMap.get(sticky.agentId) || "处理任务中",
    };
  }

  /**
   * Get or create the user's primary agent. Used when agent is idle.
   */
  async getOrCreateAgent(userId: string): Promise<GateResult> {
    const sticky = this._getSticky(userId);
    if (sticky) {
      // Verify agent still active
      const agent = this.agentRepo.getById(sticky.agentId) as any;
      if (agent && agent.status === "active") {
        this._touchSticky(userId);
        return {
          sessionId: sticky.sessionId,
          agentId: sticky.agentId,
          agentName: sticky.agentName,
          isNew: false,
        };
      }
    }
    // No active agent — create default
    return this._createNewAgent(userId, "助手", "通用对话助手");
  }

  /**
   * Queue a message to wait for the busy agent to become idle.
   * Resolves when the agent finishes its current work.
   */
  queueForAgent(userId: string, message: string): Promise<GateResult> {
    const sticky = this._getSticky(userId);
    if (!sticky) {
      // Edge case: no sticky but somehow asked to queue — just create new
      return this._createNewAgent(userId, "助手", "通用对话助手");
    }

    return new Promise<GateResult>((resolve) => {
      const queue = waitQueue.get(sticky.agentId) || [];
      queue.push({ resolve, userId, message });
      waitQueue.set(sticky.agentId, queue);
    });
  }

  /**
   * Create a new agent for the user and switch sticky to it.
   * Returns the new agent's info.
   */
  async createNewAgent(userId: string): Promise<GateResult> {
    // Check max agents limit
    const count = this._countUserAgents(userId);
    if (count >= this.maxAgents) {
      // Hit limit — recycle oldest idle agent
      this._recycleOldest(userId);
    }
    return this._createNewAgent(userId, "助手", "通用对话助手");
  }

  /** Mark an agent as busy with a work description */
  markBusy(agentId: string, work?: string): void {
    busyMap.set(agentId, true);
    if (work) workMap.set(agentId, work);
  }

  /** Mark an agent as idle, drain its wait queue */
  markIdle(agentId: string): void {
    busyMap.set(agentId, false);
    workMap.delete(agentId);
    this._drainQueue(agentId);
  }

  /** Update the current work description for a busy agent */
  updateWork(agentId: string, work: string): void {
    workMap.set(agentId, work);
  }

  /** Clear user's sticky session (for /new command) */
  clearUserSession(userId: string): void {
    this.db.prepare(`DELETE FROM user_sessions WHERE openid = ?`).run(userId);
  }

  /** Check if an agent is currently busy */
  isBusy(agentId: string): boolean {
    return busyMap.get(agentId) || false;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private _getSticky(userId: string): {
    sessionId: string;
    agentId: string;
    agentName: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT session_id, agent_id, agent_name FROM user_sessions WHERE openid = ?`,
      )
      .get(userId) as any;
    if (!row) return null;
    return {
      sessionId: row.session_id,
      agentId: row.agent_id,
      agentName: row.agent_name,
    };
  }

  private _touchSticky(userId: string): void {
    this.db
      .prepare(`UPDATE user_sessions SET updated_at = ? WHERE openid = ?`)
      .run(Date.now(), userId);
  }

  private _setSticky(userId: string, result: GateResult): void {
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

  private async _createNewAgent(
    userId: string,
    name: string,
    description: string,
  ): Promise<GateResult> {
    const { sessionId, agentId } = await createSessionWithAgent("base", this.db);
    this.agentRepo.update(agentId, { agent_name: name, description });

    const result: GateResult = {
      sessionId,
      agentId,
      agentName: name,
      isNew: true,
    };
    this._setSticky(userId, result);
    return result;
  }

  private _countUserAgents(_userId: string): number {
    // Count active agents (global — since this is single-user private chat)
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM agents WHERE depth = 0 AND status = 'active'`)
      .get() as { cnt: number };
    return row?.cnt ?? 0;
  }

  private _recycleOldest(_userId: string): void {
    // Find the oldest idle agent and mark it completed
    const agents = this.db
      .prepare(
        `SELECT id FROM agents WHERE depth = 0 AND status = 'active' ORDER BY updated_at ASC`,
      )
      .all() as Array<{ id: string }>;

    for (const a of agents) {
      if (!busyMap.get(a.id)) {
        this.agentRepo.update(a.id, { status: "completed" });
        return;
      }
    }
  }

  private _drainQueue(agentId: string): void {
    const queue = waitQueue.get(agentId);
    if (!queue || queue.length === 0) return;

    // Process the first queued message
    const item = queue.shift()!;
    if (queue.length === 0) waitQueue.delete(agentId);

    const agent = this.agentRepo.getById(agentId) as any;
    if (agent && agent.status === "active") {
      const result: GateResult = {
        sessionId: agent.session_id,
        agentId: agent.id,
        agentName: agent.agent_name,
        isNew: false,
      };
      this._setSticky(item.userId, result);
      item.resolve(result);
    }
  }
}
