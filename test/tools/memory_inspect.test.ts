import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import "../../src/tools/memory_inspect.js"
import { registry } from "../../src/tools/registry.js"
import { migrate } from "../../src/db/schema.js"

const ROOT = "/tmp/gc-mi-test"

describe("memory_inspect tool", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(join(ROOT, "agents", "a1"), { recursive: true })
    writeFileSync(join(ROOT, "AGENT.md"), "GLOBAL")
    writeFileSync(join(ROOT, "agents", "a1", "MEMORY.md"), "AGENT_LTM_CONTENT")
  })

  it("is registered", () => {
    expect(registry.get("memory_inspect")).not.toBeNull()
  })

  it("returns overview of all memory layers for target agent", async () => {
    const tool = registry.get("memory_inspect")!
    const res = await tool.handler(
      { layer: "all" },
      {
        sessionId: "s",
        workdir: ".",
        logger: console,
        extra: { memoryRoot: ROOT, targetAgentId: "a1" },
      } as any,
    )
    const text = res.type === "text" ? res.text : JSON.stringify(res)
    expect(text).toContain("AGENT_LTM_CONTENT")
    expect(text).toContain("GLOBAL")
  })

  it("filters to a single layer when layer param is given", async () => {
    const tool = registry.get("memory_inspect")!
    const res = await tool.handler(
      { layer: "agent_nonfixed" },
      {
        sessionId: "s",
        workdir: ".",
        logger: console,
        extra: { memoryRoot: ROOT, targetAgentId: "a1" },
      } as any,
    )
    const text = res.type === "text" ? res.text : JSON.stringify(res)
    expect(text).toContain("AGENT_LTM_CONTENT")
    expect(text).not.toContain("# 全局固定区")
  })

  it("lists public knowledge when layer=public and db provided", async () => {
    const db: any = new Database(":memory:")
    migrate(db)
    db.prepare(
      "INSERT INTO public_knowledge (id, title, doc_size, active) VALUES (?, ?, ?, 1)",
    ).run("k1", "TOPIC_TITLE_42", 123)
    const tool = registry.get("memory_inspect")!
    const res = await tool.handler(
      { layer: "public" },
      {
        sessionId: "s",
        workdir: ".",
        logger: console,
        extra: { memoryRoot: ROOT, targetAgentId: "a1", db },
      } as any,
    )
    const text = res.type === "text" ? res.text : JSON.stringify(res)
    expect(text).toContain("TOPIC_TITLE_42")
    expect(text).toContain("123B")
  })
})
