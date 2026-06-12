/**
 * Tests for SkillStore — filesystem persistence of SKILL.md playbooks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { SkillStore, slugifySkillName } from "./skill-store.js"

describe("slugifySkillName", () => {
  it("kebab-cases arbitrary titles", () => {
    expect(slugifySkillName("Debugging SSH Remote!")).toBe("debugging-ssh-remote")
  })

  it("trims and collapses separators", () => {
    expect(slugifySkillName("  Foo   Bar  ")).toBe("foo-bar")
  })

  it("keeps CJK characters", () => {
    expect(slugifySkillName("远端调试")).toBe("远端调试")
  })

  it("falls back when empty", () => {
    expect(slugifySkillName("!!!")).toMatch(/^skill-\d+$/)
  })
})

describe("SkillStore", () => {
  let root: string
  let store: SkillStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillstore-"))
    store = new SkillStore({ root })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("starts empty", () => {
    expect(store.listNames()).toEqual([])
    expect(store.listAll()).toEqual([])
  })

  it("creates a skill and writes SKILL.md with frontmatter", () => {
    const skill = store.create({
      name: "PDF Extraction",
      description: "Use when extracting text from PDFs",
      body: "# PDF Extraction\n\nUse pdfplumber.",
      tags: ["pdf", "ocr"],
    })

    expect(skill.meta.name).toBe("pdf-extraction")
    expect(skill.meta.version).toBe(1)
    expect(skill.meta.usage_count).toBe(0)
    expect(store.has("pdf-extraction")).toBe(true)
    expect(store.listNames()).toEqual(["pdf-extraction"])

    const raw = readFileSync(join(root, "pdf-extraction", "SKILL.md"), "utf-8")
    expect(raw).toContain("name: pdf-extraction")
    expect(raw).toContain('description: "Use when extracting text from PDFs"')
    expect(raw).toContain("tags: [pdf, ocr]")
    expect(raw).toContain("Use pdfplumber.")
  })

  it("round-trips a created skill via get()", () => {
    store.create({
      name: "alpha",
      description: "desc",
      body: "body text",
      source: "manual",
      tags: ["x"],
    })
    const loaded = store.get("alpha")
    expect(loaded).not.toBeNull()
    expect(loaded!.meta.description).toBe("desc")
    expect(loaded!.meta.source).toBe("manual")
    expect(loaded!.meta.tags).toEqual(["x"])
    expect(loaded!.body).toBe("body text")
  })

  it("throws when creating a duplicate", () => {
    store.create({ name: "dup", description: "d", body: "b" })
    expect(() => store.create({ name: "Dup", description: "d2", body: "b2" })).toThrow(
      /already exists/,
    )
  })

  it("updates a skill, bumping version and updated_at", () => {
    const created = store.create({ name: "beta", description: "old", body: "old body" })
    const before = created.meta.updated_at

    const updated = store.update("beta", {
      description: "new",
      body: "new body",
      tags: ["t"],
    })

    expect(updated.meta.version).toBe(2)
    expect(updated.meta.description).toBe("new")
    expect(updated.body).toBe("new body")
    expect(updated.meta.tags).toEqual(["t"])
    expect(updated.meta.created_at).toBe(created.meta.created_at)
    expect(new Date(updated.meta.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    )
  })

  it("throws when updating a non-existent skill", () => {
    expect(() => store.update("ghost", { body: "x" })).toThrow(/does not exist/)
  })

  it("looks up by un-slugified name", () => {
    store.create({ name: "My Cool Skill", description: "d", body: "b" })
    expect(store.has("My Cool Skill")).toBe(true)
    expect(store.get("My Cool Skill")).not.toBeNull()
  })

  it("records usage count", () => {
    store.create({ name: "gamma", description: "d", body: "b" })
    store.recordUsage("gamma")
    store.recordUsage("gamma")
    expect(store.get("gamma")!.meta.usage_count).toBe(2)
  })

  it("ensureRoot creates the directory", () => {
    const fresh = new SkillStore({ root: join(root, "nested", "deep") })
    expect(existsSync(fresh.root)).toBe(false)
    fresh.ensureRoot()
    expect(existsSync(fresh.root)).toBe(true)
  })
})
