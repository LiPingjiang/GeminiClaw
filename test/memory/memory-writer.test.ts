import { describe, it, expect, beforeEach } from "vitest";
import { rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { MemoryWriter } from "../../src/memory/memory-writer.js";
import { MemoryPaths } from "../../src/memory/paths.js";

const ROOT = "/tmp/gc-mw-test";

describe("MemoryWriter", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  it("appends a turn summary to today's global daily file", async () => {
    const w = new MemoryWriter(new MemoryPaths(ROOT));
    await w.recordTurn({
      userText: "把信号上传腾讯云",
      assistantText: "已上传完成",
      date: "2026-06-11",
    });
    const p = join(ROOT, "memory", "global", "daily", "2026-06-11.md");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("信号上传腾讯云");
    expect(content).toContain("已上传完成");
  });

  it("is idempotent-append (multiple turns accumulate, not overwrite)", async () => {
    const w = new MemoryWriter(new MemoryPaths(ROOT));
    await w.recordTurn({ userText: "第一件事", assistantText: "回复一", date: "2026-06-11" });
    await w.recordTurn({ userText: "第二件事", assistantText: "回复二", date: "2026-06-11" });
    const content = readFileSync(
      join(ROOT, "memory", "global", "daily", "2026-06-11.md"),
      "utf-8",
    );
    expect(content).toContain("第一件事");
    expect(content).toContain("第二件事");
  });

  it("writes to agent private daily when agentId provided", async () => {
    const w = new MemoryWriter(new MemoryPaths(ROOT));
    await w.recordTurn({
      userText: "私人内容",
      assistantText: "私人回复",
      date: "2026-06-11",
      agentId: "a1",
    });
    const p = join(ROOT, "agents", "a1", "daily", "2026-06-11.md");
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf-8")).toContain("私人内容");
  });

  it("truncates very long content to keep daily readable", async () => {
    const w = new MemoryWriter(new MemoryPaths(ROOT));
    await w.recordTurn({
      userText: "x".repeat(5000),
      assistantText: "y".repeat(5000),
      date: "2026-06-11",
    });
    const content = readFileSync(
      join(ROOT, "memory", "global", "daily", "2026-06-11.md"),
      "utf-8",
    );
    expect(content.length).toBeLessThan(2000);
  });

  it("skips writing when both sides are empty", async () => {
    const w = new MemoryWriter(new MemoryPaths(ROOT));
    await w.recordTurn({ userText: "   ", assistantText: "", date: "2026-06-11" });
    const p = join(ROOT, "memory", "global", "daily", "2026-06-11.md");
    expect(existsSync(p)).toBe(false);
  });
});
