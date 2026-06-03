// src/guidance/agent-gate.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { AgentGate } from "./agent-gate.js";
import { AgentRepository } from "../agents/repository.js";

function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE chat_sessions (
      id            TEXT PRIMARY KEY,
      title         TEXT,
      main_agent_id TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      message_count INTEGER NOT NULL DEFAULT 0,
      topic_ids     TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE chat_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE agents (
      id               TEXT PRIMARY KEY,
      session_id       TEXT,
      parent_agent_id  TEXT,
      template_name    TEXT,
      agent_name       TEXT,
      description      TEXT,
      depth            INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'active',
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE user_sessions (
      openid      TEXT PRIMARY KEY,
      session_id  TEXT,
      agent_id    TEXT,
      agent_name  TEXT,
      updated_at  INTEGER
    );
  `);
  return db;
}

describe("AgentGate", () => {
  let db: any;
  let gate: AgentGate;
  let agentRepo: AgentRepository;

  beforeEach(() => {
    db = createTestDb();
    agentRepo = new AgentRepository(db);
    gate = new AgentGate({ db, agentRepo, maxAgents: 3 });
  });

  afterEach(() => {
    db.close();
  });

  describe("checkBusy", () => {
    it("returns null when user has no agent", () => {
      const result = gate.checkBusy("user-1");
      expect(result).toBeNull();
    });

    it("returns null when agent is idle", async () => {
      // Create an agent for the user
      const gateResult = await gate.getOrCreateAgent("user-1");
      expect(gateResult.isNew).toBe(true);
      // Agent should be idle by default
      const result = gate.checkBusy("user-1");
      expect(result).toBeNull();
    });

    it("returns BusyInfo when agent is marked busy", async () => {
      const gateResult = await gate.getOrCreateAgent("user-1");
      gate.markBusy(gateResult.agentId, "画K线图");
      const result = gate.checkBusy("user-1");
      expect(result).not.toBeNull();
      expect(result!.agentId).toBe(gateResult.agentId);
      expect(result!.currentWork).toBe("画K线图");
    });
  });

  describe("getOrCreateAgent", () => {
    it("creates a new agent on first call", async () => {
      const result = await gate.getOrCreateAgent("user-1");
      expect(result.isNew).toBe(true);
      expect(result.sessionId).toBeDefined();
      expect(result.agentId).toBeDefined();
    });

    it("returns the same agent on subsequent calls", async () => {
      const first = await gate.getOrCreateAgent("user-1");
      const second = await gate.getOrCreateAgent("user-1");
      expect(second.agentId).toBe(first.agentId);
      expect(second.isNew).toBe(false);
    });
  });

  describe("markBusy / markIdle", () => {
    it("transitions agent between busy and idle", async () => {
      const result = await gate.getOrCreateAgent("user-1");
      expect(gate.isBusy(result.agentId)).toBe(false);

      gate.markBusy(result.agentId, "doing stuff");
      expect(gate.isBusy(result.agentId)).toBe(true);

      gate.markIdle(result.agentId);
      expect(gate.isBusy(result.agentId)).toBe(false);
    });
  });

  describe("createNewAgent", () => {
    it("creates a new agent and updates sticky", async () => {
      const first = await gate.getOrCreateAgent("user-1");
      const second = await gate.createNewAgent("user-1");
      expect(second.agentId).not.toBe(first.agentId);
      expect(second.isNew).toBe(true);

      // Sticky should point to the new agent
      const current = await gate.getOrCreateAgent("user-1");
      expect(current.agentId).toBe(second.agentId);
    });

    it("recycles oldest idle agent when hitting maxAgents", async () => {
      // Create 3 agents (maxAgents = 3)
      await gate.getOrCreateAgent("user-1");
      await gate.createNewAgent("user-1");
      await gate.createNewAgent("user-1");

      // Count active agents
      const countBefore = (db.prepare(
        `SELECT COUNT(*) as cnt FROM agents WHERE depth = 0 AND status = 'active'`
      ).get() as any).cnt;
      expect(countBefore).toBe(3);

      // Creating a 4th should recycle one
      await gate.createNewAgent("user-1");
      const countAfter = (db.prepare(
        `SELECT COUNT(*) as cnt FROM agents WHERE depth = 0 AND status = 'active'`
      ).get() as any).cnt;
      // Should still be 3 (one recycled, one new)
      expect(countAfter).toBe(3);
    });
  });

  describe("queueForAgent", () => {
    it("resolves when agent becomes idle", async () => {
      const result = await gate.getOrCreateAgent("user-1");
      gate.markBusy(result.agentId, "working");

      let resolved = false;
      const promise = gate.queueForAgent("user-1", "queued message").then((r) => {
        resolved = true;
        return r;
      });

      // Not resolved yet
      await new Promise((r) => setTimeout(r, 10));
      expect(resolved).toBe(false);

      // Mark idle → should resolve
      gate.markIdle(result.agentId);
      const queueResult = await promise;
      expect(resolved).toBe(true);
      expect(queueResult.agentId).toBe(result.agentId);
    });
  });

  describe("clearUserSession", () => {
    it("removes the sticky session", async () => {
      await gate.getOrCreateAgent("user-1");
      gate.clearUserSession("user-1");
      // Next call should create a new agent
      const result = await gate.getOrCreateAgent("user-1");
      expect(result.isNew).toBe(true);
    });
  });

  describe("updateWork", () => {
    it("updates the current work description", async () => {
      const result = await gate.getOrCreateAgent("user-1");
      gate.markBusy(result.agentId, "初始任务");
      gate.updateWork(result.agentId, "画K线图");
      const busyInfo = gate.checkBusy("user-1");
      expect(busyInfo!.currentWork).toBe("画K线图");
    });
  });
});
