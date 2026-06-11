import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { migrate } from "../../src/db/schema.js"
import { LayeredStrategy } from "../../src/memory/strategies/layered.js"

const ROOT = "/tmp/gc-layered-test"

// fake provider that returns empty route/triage
const fakeProvider: any = {
  name: "fake",
  chat: async () => ({ content: '{"matches":[]}' }),
  stream: async function* () {},
}

function makeStrat(db: any) {
  return new LayeredStrategy({
    db,
    routerProvider: fakeProvider,
    triageProvider: fakeProvider,
    systemPrompt: "BASE",
    recentMessageLimit: 10,
    triageAfterTurns: 99,
    compactThresholdBytes: 99999,
    maxActiveTopics: 16,
    memoryRoot: ROOT,
  } as any)
}

describe("LayeredStrategy per-agent context", () => {
  let db: any
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(join(ROOT, "agents", "a1"), { recursive: true })
    mkdirSync(join(ROOT, "memory", "global"), { recursive: true })
    writeFileSync(join(ROOT, "agents", "a1", "MEMORY.md"), "PRIVATE_MARKER_XYZ")
    writeFileSync(join(ROOT, "memory", "global", "MEMORY.md"), "GLOBAL_MARKER_ABC")
    db = new Database(":memory:")
    migrate(db)
  })

  it("injects current agent private memory into system prompt", async () => {
    const strat = makeStrat(db)
    const ctx = await strat.getContext("s1", "hello", "a1")
    const sysMsg = ctx.messages.find((m) => m.role === "system")!
    expect(String(sysMsg.content)).toContain("PRIVATE_MARKER_XYZ")
  })

  it("injects only global memory when no agentId is given (cold start)", async () => {
    const strat = makeStrat(db)
    const ctx = await strat.getContext("s1", "hello")
    const sysMsg = ctx.messages.find((m) => m.role === "system")!
    expect(String(sysMsg.content)).toContain("GLOBAL_MARKER_ABC")
    expect(String(sysMsg.content)).not.toContain("PRIVATE_MARKER_XYZ")
  })
})
