import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/schema.js";
import { AgentGate } from "../../src/guidance/agent-gate.js";
import { AgentRepository } from "../../src/agents/repository.js";

function makeGate() {
  const db: any = new Database(":memory:");
  migrate(db);
  const gate = new AgentGate({ db, agentRepo: new AgentRepository(db), maxAgents: 10 });
  return { db, gate };
}

describe("listUserAgents (real agents table)", () => {
  let db: any, gate: any;
  beforeEach(() => {
    ({ db, gate } = makeGate());
  });

  it("returns ALL active depth-0 agents, not just user_agents rows", () => {
    db.prepare(`INSERT INTO chat_sessions (id) VALUES ('s1'),('s2'),('s3')`).run();
    db.prepare(`INSERT INTO agents (id,session_id,template_name,agent_name,depth,status) VALUES
      ('a1','s1','base','助手',0,'active'),
      ('a2','s2','base','龙股助手',0,'active'),
      ('a3','s3','base','已归档',0,'archived')`).run();
    const list = gate.listUserAgents("user-x");
    const ids = list.map((a: any) => a.agentId).sort();
    expect(ids).toEqual(["a1", "a2"]); // archived excluded
  });

  it("excludes sub-agents (depth > 0)", () => {
    db.prepare(`INSERT INTO chat_sessions (id) VALUES ('s1'),('s2')`).run();
    db.prepare(`INSERT INTO agents (id,session_id,template_name,agent_name,depth,status) VALUES
      ('a1','s1','base','主助手',0,'active'),
      ('a2','s2','base','子助手',1,'active')`).run();
    const ids = gate.listUserAgents("u").map((a: any) => a.agentId);
    expect(ids).toContain("a1");
    expect(ids).not.toContain("a2");
  });

  it("attaches recent topic summary from last user message", () => {
    db.prepare(`INSERT INTO chat_sessions (id) VALUES ('s1')`).run();
    db.prepare(`INSERT INTO agents (id,session_id,template_name,agent_name,depth,status) VALUES
      ('a1','s1','base','助手',0,'active')`).run();
    db.prepare(`INSERT INTO chat_messages (session_id,role,content) VALUES
      ('s1','user','旧消息'),('s1','assistant','回复'),('s1','user','看一下今天a股信号计算完了么')`).run();
    const list = gate.listUserAgents("u");
    expect(list[0].topic).toContain("a股信号");
  });

  it("topic is empty string when no user messages", () => {
    db.prepare(`INSERT INTO chat_sessions (id) VALUES ('s1')`).run();
    db.prepare(`INSERT INTO agents (id,session_id,template_name,agent_name,depth,status) VALUES
      ('a1','s1','base','助手',0,'active')`).run();
    const list = gate.listUserAgents("u");
    expect(list[0].topic).toBe("");
  });
});
