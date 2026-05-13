import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { readIdentityFiles } from "./identity.js"

const TMP = "/tmp/gc-test-identity"

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(join(TMP, "SOUL.md"), "# SOUL\nI am an agent.")
  writeFileSync(join(TMP, "USER.md"), "# USER\nUser: Li Pingjiang")
})

afterEach(() => rmSync(TMP, { recursive: true, force: true }))

describe("readIdentityFiles", () => {
  it("reads existing identity files", () => {
    const result = readIdentityFiles(TMP)
    expect(result.soul).toBe("# SOUL\nI am an agent.")
    expect(result.user).toBe("# USER\nUser: Li Pingjiang")
    expect(result.identity).toBeNull()
  })

  it("returns null for missing files", () => {
    const result = readIdentityFiles("/nonexistent")
    expect(result.soul).toBeNull()
    expect(result.user).toBeNull()
    expect(result.identity).toBeNull()
  })
})
