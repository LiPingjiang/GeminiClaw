import { describe, it, expect, beforeEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { migrateMemoryLayout } from "../../scripts/migrate-memory-layout.js"

const ROOT = "/tmp/gc-mig-test"

describe("migrateMemoryLayout", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(join(ROOT, ".workspace", "memory"), { recursive: true })
    writeFileSync(join(ROOT, ".workspace", "MEMORY.md"), "OLD GLOBAL LTM")
    writeFileSync(join(ROOT, ".workspace", "memory", "2026-06-10.md"), "OLD DAILY")
  })

  it("moves old workspace MEMORY.md to new global path", () => {
    migrateMemoryLayout(ROOT)
    const newPath = join(ROOT, "memory", "global", "MEMORY.md")
    expect(existsSync(newPath)).toBe(true)
    expect(readFileSync(newPath, "utf-8")).toContain("OLD GLOBAL LTM")
  })

  it("moves old daily notes to new global daily dir", () => {
    migrateMemoryLayout(ROOT)
    expect(existsSync(join(ROOT, "memory", "global", "daily", "2026-06-10.md"))).toBe(true)
  })

  it("is idempotent (safe to run twice)", () => {
    migrateMemoryLayout(ROOT)
    expect(() => migrateMemoryLayout(ROOT)).not.toThrow()
  })
})
