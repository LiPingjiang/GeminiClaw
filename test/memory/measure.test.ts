import { describe, it, expect, beforeEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { MemoryPaths } from "../../src/memory/paths.js"
import {
  WorkingMemoryBuilder,
  estimateTokens,
} from "../../src/memory/working-memory.js"

const ROOT = "/tmp/gc-wm-measure-test"

describe("WorkingMemoryBuilder.measure", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(join(ROOT, "memory", "global", "daily"), { recursive: true })
    mkdirSync(join(ROOT, "agents", "a1", "daily"), { recursive: true })
    writeFileSync(join(ROOT, "AGENT.md"), "X".repeat(400)) // ~120 tok
    writeFileSync(join(ROOT, "memory", "global", "MEMORY.md"), "Y".repeat(800))
    writeFileSync(join(ROOT, "agents", "a1", "AGENT.md"), "Z".repeat(40))
    writeFileSync(join(ROOT, "agents", "a1", "MEMORY.md"), "W".repeat(40))
  })

  it("estimateTokens follows chars/4*1.2", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("X".repeat(400))).toBe(Math.ceil((400 / 4) * 1.2))
  })

  it("reports per-layer tokens, total and ratio", () => {
    const wm = new WorkingMemoryBuilder(new MemoryPaths(ROOT))
    const u = wm.measure("a1", "2026-06-11", 200_000)

    expect(u.globalFixed.chars).toBe(400)
    expect(u.globalFixed.tokens).toBe(estimateTokens("X".repeat(400)))
    expect(u.agentFixed.tokens).toBeGreaterThan(0)

    const expectedTotal =
      u.globalFixed.tokens +
      u.globalNonFixed.tokens +
      u.agentFixed.tokens +
      u.agentNonFixed.tokens
    expect(u.totalTokens).toBe(expectedTotal)

    expect(u.contextWindow).toBe(200_000)
    expect(u.ratio).toBeCloseTo(u.totalTokens / 200_000, 8)
    expect(u.ratio).toBeGreaterThan(0)
    expect(u.ratio).toBeLessThan(1)
  })

  it("defaults context window to 200000 when not provided", () => {
    const wm = new WorkingMemoryBuilder(new MemoryPaths(ROOT))
    expect(wm.measure("a1", "2026-06-11").contextWindow).toBe(200_000)
  })

  it("renders a human-readable usage summary with percentage", () => {
    const wm = new WorkingMemoryBuilder(new MemoryPaths(ROOT))
    const text = wm.renderUsageSummary("a1", "2026-06-11", 200_000)
    expect(text).toContain("记忆占用")
    expect(text).toContain("tokens")
    expect(text).toContain("%")
    expect(text).toContain("全局固定区")
    expect(text).toContain("私人非固定区")
  })
})
