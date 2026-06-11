import { describe, it, expect, beforeEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { MemoryPaths } from "../../src/memory/paths.js"
import { WorkingMemoryBuilder } from "../../src/memory/working-memory.js"

const ROOT = "/tmp/gc-wm-test"

describe("WorkingMemoryBuilder", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(join(ROOT, "memory", "global", "daily"), { recursive: true })
    mkdirSync(join(ROOT, "agents", "a1", "daily"), { recursive: true })
    writeFileSync(join(ROOT, "AGENT.md"), "GLOBAL FIXED")
    writeFileSync(join(ROOT, "memory", "global", "MEMORY.md"), "GLOBAL LTM")
    writeFileSync(join(ROOT, "agents", "a1", "AGENT.md"), "AGENT FIXED")
    writeFileSync(join(ROOT, "agents", "a1", "MEMORY.md"), "AGENT LTM")
  })

  it("assembles all four layers for a given agent", () => {
    const wm = new WorkingMemoryBuilder(new MemoryPaths(ROOT))
    const result = wm.build("a1", "2026-06-11")
    // 固定区
    expect(result.globalFixed).toContain("GLOBAL FIXED")
    expect(result.agentFixed).toContain("AGENT FIXED")
    // 非固定区
    expect(result.globalNonFixed).toContain("GLOBAL LTM")
    expect(result.agentNonFixed).toContain("AGENT LTM")
  })

  it("falls back to global-only when agent has no private memory (cold start)", () => {
    const wm = new WorkingMemoryBuilder(new MemoryPaths(ROOT))
    const result = wm.build("unknown-agent", "2026-06-11")
    expect(result.globalFixed).toContain("GLOBAL FIXED")
    expect(result.globalNonFixed).toContain("GLOBAL LTM")
    expect(result.agentFixed).toBe("")
    expect(result.agentNonFixed).toBe("")
  })

  it("renders combined system prompt with section headers", () => {
    const wm = new WorkingMemoryBuilder(new MemoryPaths(ROOT))
    const text = wm.renderSystemPrompt("a1", "2026-06-11", "助手")
    expect(text).toContain("GLOBAL FIXED")
    expect(text).toContain("AGENT FIXED")
    expect(text).toContain("AGENT LTM")
  })

  it("includes today's daily entries in non-fixed zones", () => {
    writeFileSync(join(ROOT, "memory", "global", "daily", "2026-06-11.md"), "GLOBAL TODAY")
    writeFileSync(join(ROOT, "agents", "a1", "daily", "2026-06-11.md"), "AGENT TODAY")
    const wm = new WorkingMemoryBuilder(new MemoryPaths(ROOT))
    const result = wm.build("a1", "2026-06-11")
    expect(result.globalNonFixed).toContain("GLOBAL TODAY")
    expect(result.agentNonFixed).toContain("AGENT TODAY")
  })
})
