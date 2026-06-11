import { describe, it, expect } from "vitest";
import { MemoryWriter } from "../../src/memory/memory-writer.js";
import { MemoryPaths } from "../../src/memory/paths.js";
import { rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = "/tmp/gc-mww-test";

// 集成验证：模拟 processWithAgent 在拿到 reply 后调用 MemoryWriter 的契约
describe("memory write wiring contract", () => {
  it("a turn results in a daily file entry (simulating post-appendMessages hook)", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    const writer = new MemoryWriter(new MemoryPaths(ROOT));
    const content = "用户的问题";
    const reply = "助手的回复";
    const agentId = "ag-x";
    // 这是 index.ts 中将要插入的调用形态
    await writer.recordTurn({
      userText: content,
      assistantText: reply,
      date: new Date().toISOString().slice(0, 10),
      agentId,
    });
    const date = new Date().toISOString().slice(0, 10);
    expect(existsSync(join(ROOT, "memory", "global", "daily", `${date}.md`))).toBe(true);
    expect(existsSync(join(ROOT, "agents", agentId, "daily", `${date}.md`))).toBe(true);
    expect(
      readFileSync(join(ROOT, "agents", agentId, "daily", `${date}.md`), "utf-8"),
    ).toContain("用户的问题");
  });
});
