import { describe, it, expect } from "vitest"
import { MemoryPaths } from "../../src/memory/paths.js"

describe("MemoryPaths", () => {
  const root = "/tmp/gc-test"
  const mp = new MemoryPaths(root)

  it("resolves global fixed prompt (AGENT.md)", () => {
    expect(mp.globalAgentMd()).toBe("/tmp/gc-test/AGENT.md")
  })

  it("resolves global long-term memory", () => {
    expect(mp.globalMemoryMd()).toBe("/tmp/gc-test/memory/global/MEMORY.md")
  })

  it("resolves global daily note by date", () => {
    expect(mp.globalDaily("2026-06-11")).toBe("/tmp/gc-test/memory/global/daily/2026-06-11.md")
  })

  it("resolves per-agent fixed prompt", () => {
    expect(mp.agentAgentMd("abc")).toBe("/tmp/gc-test/agents/abc/AGENT.md")
  })

  it("resolves per-agent long-term memory", () => {
    expect(mp.agentMemoryMd("abc")).toBe("/tmp/gc-test/agents/abc/MEMORY.md")
  })

  it("resolves per-agent daily note", () => {
    expect(mp.agentDaily("abc", "2026-06-11")).toBe("/tmp/gc-test/agents/abc/daily/2026-06-11.md")
  })

  it("resolves per-agent dir root", () => {
    expect(mp.agentDir("abc")).toBe("/tmp/gc-test/agents/abc")
  })

  it("resolves global daily dir", () => {
    expect(mp.globalDailyDir()).toBe("/tmp/gc-test/memory/global/daily")
  })

  it("resolves per-agent daily dir", () => {
    expect(mp.agentDailyDir("abc")).toBe("/tmp/gc-test/agents/abc/daily")
  })

  it("default root uses ~/.gemeniclaw", () => {
    const defaultMp = new MemoryPaths()
    expect(defaultMp.globalAgentMd()).toMatch(/\.gemeniclaw\/AGENT\.md$/)
  })
})
