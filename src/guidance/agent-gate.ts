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

export interface AgentInfo {
  agentId: string;
  agentName: string;
  sessionId: string;
  busy: boolean;
  /** Recent topic summary (first chars of the agent's last user message) */
  topic?: string;
}

/** Map of agentId -> busy state */
const busyMap = new Map<string, boolean>();
/** Map of agentId -> current work description */
const workMap = new Map<string, string>();
/** Map of agentId -> backgrounded flag (task still running but user freed) */
const backgroundedMap = new Map<string, boolean>();
/** Map of agentId -> callback to invoke when backgrounded task completes */
const backgroundCallbacks = new Map<string, (reply: string) => void>();
/** Queue: messages waiting for a busy agent to become idle */
const waitQueue = new Map<
  string, // agentId
  Array<{
    resolve: (result: GateResult) => void;
    userId: string;
    message: string;
  }>
>();
/** Map of agentId -> AbortController for the current run */
const abortMap = new Map<string, AbortController>();

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

  /**
   * Create (or reuse) an AbortController for the agent's current run.
   * Call this right before starting agentLoop.run() to get the signal.
   */
  getSignal(agentId: string): AbortSignal {
    // Always create a fresh controller for each new run
    const controller = new AbortController();
    abortMap.set(agentId, controller);
    return controller.signal;
  }

  /**
   * Interrupt the agent's current run by aborting its signal.
   * The agentLoop will exit at the next turn boundary.
   */
  interruptAgent(agentId: string): void {
    const controller = abortMap.get(agentId);
    if (controller) {
      controller.abort();
      abortMap.delete(agentId);
    }
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
    backgroundedMap.delete(agentId);
    abortMap.delete(agentId); // clean up any leftover controller
    this._drainQueue(agentId);
  }

  /** Update the current work description for a busy agent */
  updateWork(agentId: string, work: string): void {
    workMap.set(agentId, work);
  }

  /**
   * Mark an agent as "backgrounded": the task continues running but the user
   * is freed to interact with other agents. When the task completes, the
   * onComplete callback is invoked with the final reply.
   */
  markBackgrounded(agentId: string, onComplete: (reply: string) => void): void {
    backgroundedMap.set(agentId, true);
    backgroundCallbacks.set(agentId, onComplete);
  }

  /** Check if an agent is currently running in background mode */
  isBackgrounded(agentId: string): boolean {
    return backgroundedMap.get(agentId) || false;
  }

  /**
   * Called when a backgrounded task finishes. Invokes the completion callback
   * and cleans up state. Returns true if the agent was backgrounded.
   */
  completeBackground(agentId: string, reply: string): boolean {
    const cb = backgroundCallbacks.get(agentId);
    if (!cb) return false;
    backgroundCallbacks.delete(agentId);
    backgroundedMap.delete(agentId);
    cb(reply);
    return true;
  }

  /** Clear user's sticky session (for /new command) */
  clearUserSession(userId: string): void {
    this.db.prepare(`DELETE FROM user_sessions WHERE openid = ?`).run(userId);
  }

  /** Check if an agent is currently busy */
  isBusy(agentId: string): boolean {
    return busyMap.get(agentId) || false;
  }

  /** Get the agentId currently bound to a user (null if none) */
  getUserAgentId(userId: string): string | null {
    return this._getSticky(userId)?.agentId ?? null;
  }

  /**
   * List all active top-level agents, with busy/idle status and a recent-topic
   * summary used to disambiguate identically-named agents in the picker.
   * Queries the real `agents` table (depth=0, active) rather than the sparse
   * user_agents mapping table. `userId` is kept for signature compatibility.
   */
  listUserAgents(_userId: string): AgentInfo[] {
    const rows = this.db
      .prepare(
        `SELECT a.id AS agent_id, a.agent_name, a.session_id,
                (SELECT substr(m.content, 1, 16) FROM chat_messages m
                 WHERE m.session_id = a.session_id AND m.role = 'user'
                 ORDER BY m.id DESC LIMIT 1) AS topic
         FROM agents a
         WHERE a.depth = 0 AND a.status = 'active'
         ORDER BY a.updated_at DESC`,
      )
      .all() as Array<{
      agent_id: string;
      agent_name: string;
      session_id: string;
      topic: string | null;
    }>;

    return rows.map((r) => ({
      agentId: r.agent_id,
      agentName: r.agent_name,
      sessionId: r.session_id,
      busy: busyMap.get(r.agent_id) || false,
      topic: (r.topic || "").replace(/\n+/g, " ").trim(),
    }));
  }

  /**
   * Switch the user's sticky session to an existing agent.
   * Returns GateResult for the switched agent.
   */
  async switchToAgent(userId: string, agentId: string): Promise<GateResult> {
    const agent = this.agentRepo.getById(agentId) as any;
    if (!agent || agent.status !== "active") {
      throw new Error(`Agent not found or inactive: ${agentId}`);
    }

    const result: GateResult = {
      sessionId: agent.session_id,
      agentId: agent.id,
      agentName: agent.agent_name,
      isNew: false,
    };
    this._setSticky(userId, result);
    return result;
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
    this._recordUserAgent(userId, result);
    return result;
  }

  /** Record agent in user_agents mapping table */
  private _recordUserAgent(userId: string, result: GateResult): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO user_agents (openid, agent_id, session_id, agent_name)
         VALUES (?, ?, ?, ?)`,
      )
      .run(userId, result.agentId, result.sessionId, result.agentName);
  }

  private _countUserAgents(_userId: string): number {
    // Count active agents (global — since this is single-user private chat)
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM agents WHERE depth = 0 AND status = 'active'`)
      .get() as { cnt: number };
    return row?.cnt ?? 0;
  }

  private _recycleOldest(userId: string): void {
    // Find the oldest idle agent and mark it completed
    const agents = this.db
      .prepare(
        `SELECT id FROM agents WHERE depth = 0 AND status = 'active' ORDER BY updated_at ASC`,
      )
      .all() as Array<{ id: string }>;

    for (const a of agents) {
      if (!busyMap.get(a.id)) {
        this.agentRepo.update(a.id, { status: "completed" });
        // Clean up user_agents record
        this.db
          .prepare(`DELETE FROM user_agents WHERE openid = ? AND agent_id = ?`)
          .run(userId, a.id);
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
