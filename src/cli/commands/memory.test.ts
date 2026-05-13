import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { readMemory, readDailyMemory, appendMemory } from "./memory.js"

const TMP = "/tmp/gc-test-memory"

beforeEach(() => {
  mkdirSync(join(TMP, "memory"), { recursive: true })
  writeFileSync(join(TMP, "MEMORY.md"), "# Long-term Memory\n\n- item 1")
  writeFileSync(join(TMP, "memory/2026-05-13.md"), "# 2026-05-13\n\n- daily item")
})

afterEach(() => rmSync(TMP, { recursive: true, force: true }))

describe("readMemory", () => {
  it("reads MEMORY.md", () => {
    expect(readMemory(TMP)).toBe("# Long-term Memory\n\n- item 1")
  })
  it("returns null when missing", () => {
    expect(readMemory("/nonexistent")).toBeNull()
  })
})

describe("readDailyMemory", () => {
  it("reads daily memory file", () => {
    expect(readDailyMemory(TMP, "2026-05-13")).toContain("daily item")
  })
  it("returns null for missing date", () => {
    expect(readDailyMemory(TMP, "2000-01-01")).toBeNull()
  })
})

describe("appendMemory", () => {
  it("appends entry with timestamp to MEMORY.md", () => {
    appendMemory(TMP, "new insight")
    const content = readMemory(TMP)!
    expect(content).toContain("new insight")
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})
