import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { syncFromWorkspace, type SyncResult } from "./sync.js"

const SRC = "/tmp/gc-test-sync-src"
const DEST = "/tmp/gc-test-sync-dest"

beforeEach(() => {
  mkdirSync(join(SRC, "memory"), { recursive: true })
  writeFileSync(join(SRC, "SOUL.md"), "# SOUL\nI am an agent.")
  writeFileSync(join(SRC, "USER.md"), "# USER\nUser: Li Pingjiang")
  writeFileSync(join(SRC, "IDENTITY.md"), "# IDENTITY\nName: Guanlan")
  writeFileSync(join(SRC, "MEMORY.md"), "# Long-term Memory")
  writeFileSync(join(SRC, "AGENTS.md"), "# AGENTS")
  writeFileSync(join(SRC, "TOOLS.md"), "# TOOLS")
  writeFileSync(join(SRC, "memory/2026-05-13.md"), "# Daily")
  mkdirSync(DEST, { recursive: true })
})

afterEach(() => {
  rmSync(SRC, { recursive: true, force: true })
  rmSync(DEST, { recursive: true, force: true })
})

describe("syncFromWorkspace", () => {
  it("copies identity files to destination", () => {
    const result = syncFromWorkspace(SRC, DEST)
    expect(existsSync(join(DEST, "SOUL.md"))).toBe(true)
    expect(existsSync(join(DEST, "USER.md"))).toBe(true)
    expect(existsSync(join(DEST, "IDENTITY.md"))).toBe(true)
    expect(existsSync(join(DEST, "MEMORY.md"))).toBe(true)
  })

  it("copies daily memory files", () => {
    const result = syncFromWorkspace(SRC, DEST)
    expect(existsSync(join(DEST, "memory/2026-05-13.md"))).toBe(true)
  })

  it("creates TOOLS-ADAPTATION-NOTES.md", () => {
    syncFromWorkspace(SRC, DEST)
    expect(existsSync(join(DEST, "TOOLS-ADAPTATION-NOTES.md"))).toBe(true)
    const notes = readFileSync(join(DEST, "TOOLS-ADAPTATION-NOTES.md"), "utf-8")
    expect(notes).toContain("OpenClaw")
  })

  it("returns summary of copied files", () => {
    const result = syncFromWorkspace(SRC, DEST)
    expect(result.copied.length).toBeGreaterThan(0)
    expect(result.skipped).toBeDefined()
  })
})
