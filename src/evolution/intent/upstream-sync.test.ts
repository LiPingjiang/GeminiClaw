import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { EvolutionDB } from "../db.js"
import { UpstreamSyncSource } from "./upstream-sync.js"
import type { ProviderRouter } from "../../providers/router.js"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

function makeTmpDb(): { db: EvolutionDB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gc-test-"))
  const dbPath = join(dir, "test.db")
  const db = new EvolutionDB(dbPath)
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("UpstreamSyncSource", () => {
  let db: EvolutionDB
  let cleanup: () => void
  let mockRouter: ProviderRouter

  beforeEach(() => {
    const tmp = makeTmpDb()
    db = tmp.db
    cleanup = tmp.cleanup
    mockRouter = {
      chat: vi.fn().mockResolvedValue({
        content: "[]",
        model: "test",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      stream: vi.fn(),
    } as unknown as ProviderRouter
  })

  afterEach(() => cleanup())

  it("returns empty array when no upstream repos configured", async () => {
    const source = new UpstreamSyncSource({ db, providerRouter: mockRouter, repoRoot: "/tmp" })
    const intents = await source.check()
    expect(intents).toEqual([])
  })

  it("records upstream check in DB even with no repos", async () => {
    const source = new UpstreamSyncSource({ db, providerRouter: mockRouter, repoRoot: "/tmp" })
    await source.check()
    const last = db.getLastUpstreamCheck()
    expect(last).not.toBeNull()
    expect(last!.intentGenerated).toBe(false)
  })

  it("skips repos with invalid paths gracefully", async () => {
    const source = new UpstreamSyncSource({
      db,
      providerRouter: mockRouter,
      repoRoot: "/tmp",
      upstreamRepos: [{ name: "test", path: "/nonexistent/repo", baseCommit: "abc123" }],
    })
    const intents = await source.check()
    expect(intents).toEqual([])
  })
})
