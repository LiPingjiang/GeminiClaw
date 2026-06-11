import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import "../../src/tools/memory_search.js";
import { registry } from "../../src/tools/registry.js";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/schema.js";

const ROOT = "/tmp/gc-ms-test";

function textOf(res: any): string {
  return res.type === "text" ? res.text : JSON.stringify(res);
}

describe("memory_search tool", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(join(ROOT, "memory", "global", "daily"), { recursive: true });
    mkdirSync(join(ROOT, "agents", "a1", "daily"), { recursive: true });
    writeFileSync(
      join(ROOT, "memory", "global", "daily", "2026-06-11.md"),
      "今天讨论了24个线上策略清单 V130",
    );
    writeFileSync(
      join(ROOT, "agents", "a1", "MEMORY.md"),
      "私人记忆：腾讯云服务器信号上传",
    );
  });

  it("is registered", () => {
    expect(registry.get("memory_search")).not.toBeNull();
  });

  it("finds keyword in global daily files", async () => {
    const tool = registry.get("memory_search")!;
    const res = await tool.handler(
      { query: "24个线上策略" },
      { sessionId: "s", workdir: ".", logger: console, extra: { memoryRoot: ROOT, targetAgentId: "a1" } } as any,
    );
    const text = textOf(res);
    expect(text).toContain("V130");
    expect(text).toContain("2026-06-11");
  });

  it("finds keyword in agent private memory files", async () => {
    const tool = registry.get("memory_search")!;
    const res = await tool.handler(
      { query: "腾讯云" },
      { sessionId: "s", workdir: ".", logger: console, extra: { memoryRoot: ROOT, targetAgentId: "a1" } } as any,
    );
    const text = textOf(res);
    expect(text).toContain("信号上传");
  });

  it("returns a clear message when nothing matches", async () => {
    const tool = registry.get("memory_search")!;
    const res = await tool.handler(
      { query: "完全不存在的关键词xyz" },
      { sessionId: "s", workdir: ".", logger: console, extra: { memoryRoot: ROOT, targetAgentId: "a1" } } as any,
    );
    const text = textOf(res);
    expect(text).toContain("未找到");
  });

  it("errors on empty query", async () => {
    const tool = registry.get("memory_search")!;
    const res = await tool.handler(
      { query: "  " },
      { sessionId: "s", workdir: ".", logger: console, extra: { memoryRoot: ROOT, targetAgentId: "a1" } } as any,
    );
    expect(res.type).toBe("error");
  });

  it("finds keyword in chat_messages history across sessions", async () => {
    const db: any = new Database(":memory:");
    migrate(db);
    db.prepare(`INSERT INTO chat_sessions (id) VALUES ('sess-1')`).run();
    db.prepare(
      `INSERT INTO agents (id, session_id, template_name, agent_name) VALUES ('ag-1','sess-1','base','龙股助手')`,
    ).run();
    db.prepare(
      `INSERT INTO chat_messages (session_id, role, content) VALUES ('sess-1','user','我给过你24个线上策略的全部明细')`,
    ).run();
    const tool = registry.get("memory_search")!;
    const res = await tool.handler(
      { query: "24个线上策略" },
      { sessionId: "s", workdir: ".", logger: console, extra: { memoryRoot: ROOT, targetAgentId: "a1", db } } as any,
    );
    const text = textOf(res);
    expect(text).toContain("历史会话");
    expect(text).toContain("龙股助手");
  });

  it("finds keyword in public_knowledge", async () => {
    const db: any = new Database(":memory:");
    migrate(db);
    db.prepare(
      `INSERT INTO public_knowledge (id, title, summary, active) VALUES ('k1','龙股Agent创建','信号上传腾讯云',1)`,
    ).run();
    const tool = registry.get("memory_search")!;
    const res = await tool.handler(
      { query: "腾讯云" },
      { sessionId: "s", workdir: ".", logger: console, extra: { memoryRoot: ROOT, targetAgentId: "a1", db } } as any,
    );
    const text = textOf(res);
    expect(text).toContain("公共知识库");
  });
});
