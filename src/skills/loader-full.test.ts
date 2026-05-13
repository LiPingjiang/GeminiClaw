import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { SkillLoader } from "./loader-full.js"

const TMP = "/tmp/gc-test-skills"

beforeEach(() => {
  mkdirSync(join(TMP, "hello"), { recursive: true })
  writeFileSync(join(TMP, "hello/SKILL.md"), `---
name: hello
description: A test skill
---
# Hello Skill
`)
  // legacy flat format
  writeFileSync(join(TMP, "legacy_SKILL.md"), `---
name: legacy
description: Legacy flat skill
---
# Legacy
`)
})

afterEach(() => rmSync(TMP, { recursive: true, force: true }))

describe("SkillLoader", () => {
  it("loads subdirectory format SKILL.md", () => {
    const skills = SkillLoader.loadSkills(TMP)
    const hello = skills.find(s => s.name === "hello")
    expect(hello).toBeDefined()
    expect(hello!.description).toBe("A test skill")
  })

  it("loads legacy flat _SKILL.md format", () => {
    const skills = SkillLoader.loadSkills(TMP)
    const legacy = skills.find(s => s.name === "legacy")
    expect(legacy).toBeDefined()
  })

  it("loads both formats together", () => {
    const skills = SkillLoader.loadSkills(TMP)
    expect(skills.length).toBe(2)
  })
})
