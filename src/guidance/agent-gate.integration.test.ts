// src/guidance/agent-gate.integration.test.ts
// Integration test: validates the full busy → keyboard → interaction → new agent pipeline.
//
// This simulates the QQBot channel flow:
//   1. User sends message → agent idle → getOrCreateAgent → markBusy → process → markIdle
//   2. User sends message → agent busy → checkBusy returns BusyInfo → pendingBusy.set → keyboard
//   3. User clicks "new" → createNewAgent → get signal → markBusy → process → markIdle
//   4. User clicks "queue" → queueForAgent → waits for idle → resolves
//   5. User clicks button with expired requestId → graceful fallback
//   6. interrupt flow

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { AgentGate, type BusyInfo, type GateResult } from "./agent-gate.js";
import { AgentRepository } from "../agents/repository.js";

// ── In-memory DB setup ──────────────────────────────────────────────────
function createTestDb(): Database.Database {
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
    CREATE TABLE IF NOT EXISTS user_agents (
      openid      TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      agent_name  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (openid, agent_id)
    );
  `);
  return db;
}

// ── Simulated pendingBusy map (mirrors QQBot channel's local map) ───────
interface PendingBusyEntry {
  userId: string;
  message: string;
  msgId: string;
  source: { type: string; openid: string };
}

// ── Simulated interaction event ─────────────────────────────────────────
interface SimInteractionEvent {
  buttonData: string;
  userOpenid: string;
  chatType: "c2c" | "group";
  groupOpenid?: string;
}

describe("AgentGate — busy → keyboard → interaction full pipeline", () => {
  let db: Database.Database;
  let gate: AgentGate;
  let agentRepo: AgentRepository;
  let pendingBusy: Map<string, PendingBusyEntry>;

  // Messages sent by the simulated "api"
  let sentMessages: Array<{ target: string; text: string }>;

  beforeEach(() => {
    db = createTestDb();
    agentRepo = new AgentRepository(db);
    gate = new AgentGate({ db, agentRepo, maxAgents: 5 });
    pendingBusy = new Map();
    sentMessages = [];
  });

  afterEach(() => {
    db.close();
  });

  // ── Helper: simulate a user sending a message (the handleMessage flow) ──
  async function simulateUserMessage(
    userId: string,
    content: string,
  ): Promise<{ replied: string; busyInfo: BusyInfo | null; requestId?: string }> {
    const busyInfo = gate.checkBusy(userId);

    if (busyInfo) {
      // Agent is busy → create pending entry + keyboard
      const requestId = randomUUID().slice(0, 8);
      pendingBusy.set(requestId, {
        userId,
        message: content,
        msgId: randomUUID(),
        source: { type: "c2c", openid: userId },
      });

      const prompt = `⏳ 助手正在忙：**${busyInfo.currentWork}**\n\n你可以选择等待当前任务完成，或者新建一个助手来处理。`;
      sentMessages.push({ target: userId, text: prompt });

      return { replied: prompt, busyInfo, requestId };
    }

    // Agent idle → get or create, mark busy, "process", mark idle
    const gateResult = await gate.getOrCreateAgent(userId);
    const signal = gate.getSignal(gateResult.agentId);
    gate.markBusy(gateResult.agentId, content.slice(0, 30));

    // Simulate processing
    const reply = `[echo] ${content}`;
    gate.markIdle(gateResult.agentId);

    sentMessages.push({ target: userId, text: reply });
    return { replied: reply, busyInfo: null };
  }

  // ── Helper: simulate interaction handler (user clicks button) ─────────
  async function simulateInteraction(event: SimInteractionEvent): Promise<void> {
    const parts = event.buttonData.split(":");
    if (parts.length < 3) return;
    const prefix = parts[0] + ":";
    if (prefix !== "busy:") return;

    const requestId = parts[1];
    const choice = parts[2]; // "queue" | "new" | "interrupt"

    const pending = pendingBusy.get(requestId);
    if (!pending) {
      // Expired — send feedback
      sentMessages.push({
        target: event.userOpenid,
        text: "⚠️ 该操作已过期（可能由于助手重启），请重新发送消息。",
      });
      return;
    }
    pendingBusy.delete(requestId);

    if (choice === "new") {
      const gateResult = await gate.createNewAgent(pending.userId);
      const newSignal = gate.getSignal(gateResult.agentId);
      gate.markBusy(gateResult.agentId, pending.message.slice(0, 30));
      // Simulate processing
      const reply = `[echo via new agent] ${pending.message}`;
      gate.markIdle(gateResult.agentId);
      sentMessages.push({ target: pending.userId, text: reply });
    } else if (choice === "queue") {
      sentMessages.push({
        target: pending.userId,
        text: "✅ 已加入队列，助手完成当前任务后会立即处理你的消息。",
      });

      // In the real QQBot flow, queueForAgent blocks until markIdle drains
      // the queue. In this synchronous simulation we can't await queueForAgent
      // because the subsequent markIdle (which drains) hasn't happened yet.
      // Instead, simulate the end-state: mark current agent idle, then get
      // the agent and process the queued message directly.
      const currentAgentId = gate.getUserAgentId(pending.userId);
      if (currentAgentId) gate.markIdle(currentAgentId);

      // Now the agent is idle — reuse it for the queued message
      const gateResult = await gate.getOrCreateAgent(pending.userId);
      gate.markBusy(gateResult.agentId, pending.message.slice(0, 30));
      const reply = `[echo via queue] ${pending.message}`;
      gate.markIdle(gateResult.agentId);
      sentMessages.push({ target: pending.userId, text: reply });
    } else if (choice === "interrupt") {
      const currentAgentId = gate.getUserAgentId(pending.userId);
      if (!currentAgentId) return;

      gate.interruptAgent(currentAgentId);
      // In real flow, the running processWithAgent catches the abort signal
      // and calls markIdle in its finally block. Simulate that here.
      gate.markIdle(currentAgentId);

      // Agent is now idle — process the new message on the same session
      const gateResult = await gate.getOrCreateAgent(pending.userId);
      gate.markBusy(gateResult.agentId, pending.message.slice(0, 30));
      const interruptSignal = gate.getSignal(gateResult.agentId);
      const reply = `[echo via interrupt] ${pending.message}`;
      gate.markIdle(gateResult.agentId);
      sentMessages.push({ target: pending.userId, text: reply });
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // 1. Happy path: first message creates agent, second finds busy
  // ──────────────────────────────────────────────────────────────────────
  it("creates agent on first message, detects busy on second", async () => {
    const userId = "user-001";

    // First message: agent idle → create → busy → process → idle
    const r1 = await simulateUserMessage(userId, "帮我画K线图");
    expect(r1.busyInfo).toBeNull();
    expect(r1.replied).toContain("帮我画K线图");

    // Now manually mark the agent busy (simulate a long-running task)
    const agentId = gate.getUserAgentId(userId);
    expect(agentId).not.toBeNull();
    gate.markBusy(agentId!, "画K线图中…");

    // Second message: agent is busy
    const r2 = await simulateUserMessage(userId, "帮我查价格");
    expect(r2.busyInfo).not.toBeNull();
    expect(r2.busyInfo!.currentWork).toBe("画K线图中…");
    expect(r2.requestId).toBeDefined();
    expect(r2.replied).toContain("助手正在忙");
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2. Full flow: busy → user clicks "new" → new agent processes message
  // ──────────────────────────────────────────────────────────────────────
  it("busy → keyboard → user clicks 'new' → new agent handles message", async () => {
    const userId = "user-002";

    // Step 1: create agent and mark busy
    const r1 = await simulateUserMessage(userId, "长任务A");
    expect(r1.busyInfo).toBeNull();
    const firstAgentId = gate.getUserAgentId(userId);
    gate.markBusy(firstAgentId!, "长任务A进行中");

    // Step 2: second message → busy → keyboard
    const r2 = await simulateUserMessage(userId, "紧急消息B");
    expect(r2.busyInfo).not.toBeNull();
    expect(r2.requestId).toBeDefined();

    // Step 3: user clicks "新建助手" button
    await simulateInteraction({
      buttonData: `busy:${r2.requestId}:new`,
      userOpenid: userId,
      chatType: "c2c",
    });

    // Step 4: verify new agent was created and processed the message
    const newAgentId = gate.getUserAgentId(userId);
    expect(newAgentId).not.toBe(firstAgentId);
    expect(sentMessages).toContainEqual(
      expect.objectContaining({ target: userId, text: expect.stringContaining("紧急消息B") }),
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // 3. Full flow: busy → user clicks "queue" → current task finishes → queued msg processed
  // ──────────────────────────────────────────────────────────────────────
  it("busy → keyboard → user clicks 'queue' → current task finishes → queued msg processed", async () => {
    const userId = "user-003";

    // Create agent, mark busy
    await simulateUserMessage(userId, "长任务");
    const agentId = gate.getUserAgentId(userId);
    gate.markBusy(agentId!, "长任务进行中");

    // Second message → busy → keyboard
    const r2 = await simulateUserMessage(userId, "排队消息");
    expect(r2.requestId).toBeDefined();

    // User clicks "排队等待"
    // simulateInteraction marks the current agent idle (simulating task
    // completion), then queueForAgent resolves and processes the queued message.
    await simulateInteraction({
      buttonData: `busy:${r2.requestId}:queue`,
      userOpenid: userId,
      chatType: "c2c",
    });

    // Verify ack was sent
    expect(sentMessages).toContainEqual(
      expect.objectContaining({ target: userId, text: expect.stringContaining("已加入队列") }),
    );
    // Verify the queued message was eventually processed
    expect(sentMessages).toContainEqual(
      expect.objectContaining({ target: userId, text: expect.stringContaining("排队消息") }),
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // 4. Expired requestId → graceful fallback message
  // ──────────────────────────────────────────────────────────────────────
  it("expired requestId → sends expired warning to user", async () => {
    const userId = "user-004";

    // Simulate user clicking a button with an unknown requestId (e.g., after restart)
    await simulateInteraction({
      buttonData: "busy:deadbeef:new",
      userOpenid: userId,
      chatType: "c2c",
    });

    // Should send the expired warning
    expect(sentMessages).toContainEqual(
      expect.objectContaining({
        target: userId,
        text: expect.stringContaining("已过期"),
      }),
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // 5. markBusy → checkBusy returns BusyInfo → markIdle → checkBusy null
  // ──────────────────────────────────────────────────────────────────────
  it("markBusy/checkBusy/markIdle cycle works correctly", async () => {
    const userId = "user-005";

    // No agent yet → checkBusy returns null
    expect(gate.checkBusy(userId)).toBeNull();

    // Create agent
    const result = await gate.getOrCreateAgent(userId);
    expect(result.isNew).toBe(true);
    expect(result.agentId).toBeDefined();

    // Not busy yet
    expect(gate.checkBusy(userId)).toBeNull();

    // Mark busy
    gate.markBusy(result.agentId, "分析数据中");
    const busy = gate.checkBusy(userId);
    expect(busy).not.toBeNull();
    expect(busy!.agentId).toBe(result.agentId);
    expect(busy!.currentWork).toBe("分析数据中");
    expect(gate.isBusy(result.agentId)).toBe(true);

    // Mark idle
    gate.markIdle(result.agentId);
    expect(gate.checkBusy(userId)).toBeNull();
    expect(gate.isBusy(result.agentId)).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 6. createNewAgent returns a different agentId
  // ──────────────────────────────────────────────────────────────────────
  it("createNewAgent returns new agent and switches sticky", async () => {
    const userId = "user-006";

    const first = await gate.getOrCreateAgent(userId);
    expect(first.isNew).toBe(true);

    const second = await gate.createNewAgent(userId);
    expect(second.isNew).toBe(true);
    expect(second.agentId).not.toBe(first.agentId);

    // Sticky should point to the new agent
    const current = await gate.getOrCreateAgent(userId);
    expect(current.agentId).toBe(second.agentId);
    expect(current.isNew).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 7. queueForAgent resolves when agent becomes idle
  // ──────────────────────────────────────────────────────────────────────
  it("queueForAgent resolves after markIdle drains queue", async () => {
    const userId = "user-007";

    const result = await gate.getOrCreateAgent(userId);
    gate.markBusy(result.agentId, "working");

    let resolved = false;
    const queuePromise = gate.queueForAgent(userId, "queued message").then((r) => {
      resolved = true;
      return r;
    });

    // Not resolved yet
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Mark idle → drain queue
    gate.markIdle(result.agentId);
    const queueResult = await queuePromise;
    expect(resolved).toBe(true);
    expect(queueResult.agentId).toBe(result.agentId);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 8. Interrupt flow: busy → interrupt → agent aborted → re-queue
  // ──────────────────────────────────────────────────────────────────────
  it("interrupt flow: aborts current agent and processes new message", async () => {
    const userId = "user-008";

    // Create agent and mark busy
    await simulateUserMessage(userId, "长任务X");
    const agentId = gate.getUserAgentId(userId);
    gate.markBusy(agentId!, "长任务X进行中");

    // Second message → busy → keyboard
    const r2 = await simulateUserMessage(userId, "打断消息Y");
    expect(r2.busyInfo).not.toBeNull();
    expect(r2.requestId).toBeDefined();

    // User clicks "打断任务"
    await simulateInteraction({
      buttonData: `busy:${r2.requestId}:interrupt`,
      userOpenid: userId,
      chatType: "c2c",
    });

    // Verify the interrupt message was processed
    expect(sentMessages).toContainEqual(
      expect.objectContaining({ target: userId, text: expect.stringContaining("打断消息Y") }),
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // 9. Full end-to-end: message → busy → "new" → both agents exist
  // ──────────────────────────────────────────────────────────────────────
  it("end-to-end: two agents coexist after busy → new flow", async () => {
    const userId = "user-009";

    // First message → create agent1
    const r1 = await simulateUserMessage(userId, "任务一");
    const agent1Id = gate.getUserAgentId(userId);
    expect(agent1Id).toBeDefined();

    // Keep agent1 busy
    gate.markBusy(agent1Id!, "任务一进行中");

    // Second message → busy → keyboard
    const r2 = await simulateUserMessage(userId, "任务二");
    expect(r2.requestId).toBeDefined();

    // User clicks "new"
    await simulateInteraction({
      buttonData: `busy:${r2.requestId}:new`,
      userOpenid: userId,
      chatType: "c2c",
    });

    // Now agent2 is the sticky one
    const agent2Id = gate.getUserAgentId(userId);
    expect(agent2Id).not.toBe(agent1Id);

    // Both agents exist in DB
    const a1 = agentRepo.getById(agent1Id!);
    const a2 = agentRepo.getById(agent2Id!);
    expect(a1).not.toBeNull();
    expect(a2).not.toBeNull();

    // Verify both agents have status 'active'
    expect(a1!.status).toBe("active");
    expect(a2!.status).toBe("active");
  });
});
