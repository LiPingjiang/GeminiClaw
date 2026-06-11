import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/schema.js";
import { AgentGate } from "../../src/guidance/agent-gate.js";
import { AgentRepository } from "../../src/agents/repository.js";

// Contract: every agent returned by listUserAgents (including busy ones) must be
// selectable via switchToAgent, enabling the queue/interrupt flow for busy agents.
describe("select-all-agents contract", () => {
  let db: any, gate: any;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    gate = new AgentGate({ db, agentRepo: new AgentRepository(db), maxAgents: 10 });
    db.prepare(`INSERT INTO chat_sessions (id) VALUES ('s1'),('s2')`).run();
    db.prepare(`INSERT INTO agents (id,session_id,template_name,agent_name,depth,status) VALUES
      ('a1','s1','base','助手',0,'active'),
      ('a2','s2','base','龙股助手',0,'active')`).run();
  });

  it("a busy agent still appears in listUserAgents", () => {
    gate.markBusy("a1", "忙碌中");
    const list = gate.listUserAgents("u");
    const a1 = list.find((a: any) => a.agentId === "a1");
    expect(a1).toBeDefined();
    expect(a1.busy).toBe(true);
  });

  it("switchToAgent works on a busy agent (enables queue/interrupt flow)", async () => {
    gate.markBusy("a1", "忙碌中");
    const res = await gate.switchToAgent("u", "a1");
    expect(res.agentId).toBe("a1");
    expect(gate.getUserAgentId("u")).toBe("a1");
  });
});
