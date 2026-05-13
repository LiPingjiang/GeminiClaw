import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync } from "fs"
import { SkillRegistry } from "./skill-registry.js"

const TMP = "/tmp/gc-test-registry"

beforeEach(() => mkdirSync(TMP, { recursive: true }))
afterEach(() => rmSync(TMP, { recursive: true, force: true }))

describe("SkillRegistry", () => {
  it("creates empty registry when file does not exist", () => {
    const reg = new SkillRegistry(TMP)
    expect(reg.list()).toEqual([])
  })

  it("registers a skill with source", () => {
    const reg = new SkillRegistry(TMP)
    reg.register("brainstorming", {
      source: "github:obra/superpowers",
      version: "v5.1.0",
      updateUrl: "https://github.com/obra/superpowers/tree/main/skills/brainstorming",
    })
    const entry = reg.get("brainstorming")
    expect(entry).toBeDefined()
    expect(entry!.source).toBe("github:obra/superpowers")
    expect(entry!.version).toBe("v5.1.0")
    expect(entry!.installedAt).toMatch(/^\d{4}-/)
  })

  it("persists registry to disk", () => {
    const reg = new SkillRegistry(TMP)
    reg.register("hello", { source: "local" })

    const reg2 = new SkillRegistry(TMP)
    expect(reg2.get("hello")).toBeDefined()
    expect(reg2.get("hello")!.source).toBe("local")
  })

  it("lists all registered skills", () => {
    const reg = new SkillRegistry(TMP)
    reg.register("a", { source: "local" })
    reg.register("b", { source: "github:obra/superpowers" })
    expect(reg.list()).toHaveLength(2)
  })

  it("groups skills by source", () => {
    const reg = new SkillRegistry(TMP)
    reg.register("a", { source: "github:obra/superpowers" })
    reg.register("b", { source: "github:obra/superpowers" })
    reg.register("c", { source: "local" })
    const groups = reg.groupBySource()
    expect(groups["github:obra/superpowers"]).toHaveLength(2)
    expect(groups["local"]).toHaveLength(1)
  })
})
