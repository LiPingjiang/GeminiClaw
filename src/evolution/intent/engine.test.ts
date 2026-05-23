import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { EvolutionDB } from "../db.js"
import { IntentEngine } from "./engine.js"
import type { ProviderRouter } from "../../providers/router.js"

function makeTmpDb(): { db: EvolutionDB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gc-intent-"))
  const dbPath = join(dir, "test.db")
  const db = new EvolutionDB(dbPath)
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("IntentEngine", () => {
  let db: EvolutionDB
  let cleanup: () => void
  let mockRouter: ProviderRouter

  beforeEach(() => {
    const tmp = makeTmpDb()
    db = tmp.db
    cleanup = tmp.cleanup
    mockRouter = {
      chat: vi.fn().mockResolvedValue({ content: "[]", model: "test" }),
      stream: vi.fn(),
    } as unknown as ProviderRouter
  })

  afterEach(() => cleanup())

  it("returns 0 when no traces and no upstream repos", async () => {
    const engine = new IntentEngine({
      db,
      providerRouter: mockRouter,
      repoRoot: "/tmp",
      memoryDbPath: ":memory:",
    })
    const count = await engine.generateIntents()
    expect(count).toBe(0)
  })

  it("generates intents from traces when failure rate is high", async () => {
    for (let i = 0; i < 10; i++) {
      db.insertTrace({
        id: `t${i}`,
        sessionId: "s1",
        toolSequence: ["exec"],
        hadFailure: i < 7,
        responseLength: 100,
        messageCount: 1,
        recordedAt: Date.now() - i * 1000,
      })
    }
    const engine = new IntentEngine({
      db,
      providerRouter: mockRouter,
      repoRoot: "/tmp",
      memoryDbPath: ":memory:",
    })
    const count = await engine.generateIntents()
    expect(count).toBe(1)

    const intents = db.listIntents({ status: "pending" })
    expect(intents).toHaveLength(1)
    expect(intents[0].type).toBe("behavior_fix")
  })

  it("deduplicates: same description not inserted twice", async () => {
    for (let i = 0; i < 10; i++) {
      db.insertTrace({
        id: `t${i}`,
        sessionId: "s1",
        toolSequence: ["exec"],
        hadFailure: i < 7,
        responseLength: 100,
        messageCount: 1,
        recordedAt: Date.now() - i * 1000,
      })
    }
    const engine = new IntentEngine({
      db,
      providerRouter: mockRouter,
      repoRoot: "/tmp",
      memoryDbPath: ":memory:",
    })
    await engine.generateIntents()
    await engine.generateIntents() // second call should not duplicate

    const intents = db.listIntents({ status: "pending" })
    expect(intents).toHaveLength(1)
  })

  it("addUserIntent creates intent with correct type and status", () => {
    const engine = new IntentEngine({
      db,
      providerRouter: mockRouter,
      repoRoot: "/tmp",
      memoryDbPath: ":memory:",
    })
    const id = engine.addUserIntent({
      description: "Optimize response caching",
      targetFiles: ["src/providers/anthropic.ts"],
      riskLevel: "low",
    })
    expect(typeof id).toBe("string")
    const intent = db.getIntent(id)
    expect(intent).not.toBeNull()
    expect(intent!.type).toBe("new_feature")
    expect(intent!.status).toBe("pending")
  })
})
