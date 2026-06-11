import { describe, it, expect, beforeEach } from "vitest"
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs"
import { join } from "path"
import "../../src/tools/memory_edit.js"
import { registry } from "../../src/tools/registry.js"

const ROOT = "/tmp/gc-me-test"

function ctx() {
  return {
    sessionId: "s",
    workdir: ".",
    logger: console,
    extra: { memoryRoot: ROOT, targetAgentId: "a1" },
  } as any
}

describe("memory_edit tool", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(join(ROOT, "agents", "a1"), { recursive: true })
  })

  it("is registered", () => {
    expect(registry.get("memory_edit")).not.toBeNull()
  })

  it("writes agent non-fixed memory (MEMORY.md)", async () => {
    const tool = registry.get("memory_edit")!
    const res = await tool.handler(
      { layer: "agent_nonfixed", mode: "replace", content: "NEW PRIVATE NOTE" },
      ctx(),
    )
    expect(res.type).toBe("text")
    const file = join(ROOT, "agents", "a1", "MEMORY.md")
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, "utf-8")).toContain("NEW PRIVATE NOTE")
  })

  it("refuses to edit fixed layer without confirm flag", async () => {
    const tool = registry.get("memory_edit")!
    const res = await tool.handler(
      { layer: "agent_fixed", mode: "replace", content: "hack identity" },
      ctx(),
    )
    expect(res.type).toBe("error")
    expect(existsSync(join(ROOT, "agents", "a1", "AGENT.md"))).toBe(false)
  })

  it("allows editing fixed layer with confirm=true", async () => {
    const tool = registry.get("memory_edit")!
    const res = await tool.handler(
      { layer: "agent_fixed", mode: "replace", content: "# 助手\n职责说明", confirm: true },
      ctx(),
    )
    expect(res.type).toBe("text")
    const file = join(ROOT, "agents", "a1", "AGENT.md")
    expect(readFileSync(file, "utf-8")).toContain("职责说明")
  })

  it("appends to agent non-fixed memory", async () => {
    const tool = registry.get("memory_edit")!
    await tool.handler({ layer: "agent_nonfixed", mode: "replace", content: "L1" }, ctx())
    await tool.handler({ layer: "agent_nonfixed", mode: "append", content: "L2" }, ctx())
    const file = join(ROOT, "agents", "a1", "MEMORY.md")
    const txt = readFileSync(file, "utf-8")
    expect(txt).toContain("L1")
    expect(txt).toContain("L2")
  })

  it("returns error for unknown layer", async () => {
    const tool = registry.get("memory_edit")!
    const res = await tool.handler(
      { layer: "bogus", mode: "replace", content: "x" },
      ctx(),
    )
    expect(res.type).toBe("error")
  })

  it("returns error when agent layer used without targetAgentId", async () => {
    const tool = registry.get("memory_edit")!
    const res = await tool.handler(
      { layer: "agent_nonfixed", mode: "replace", content: "x" },
      { sessionId: "s", workdir: ".", logger: console, extra: { memoryRoot: ROOT } } as any,
    )
    expect(res.type).toBe("error")
  })
})
