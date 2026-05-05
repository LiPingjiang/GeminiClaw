// src/memory/strategies/layered.test.ts
import { it, expect, vi, afterEach } from "vitest"
import { existsSync, rmSync } from "fs"
import { openDb, migrate } from "../../db/schema.js"
import type { Provider } from "../../providers/types.js"

const TEST_DB = "/tmp/geminiclaw-test-layered.db"

afterEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB)
})

function makeProvider(response: string): Provider {
  return {
    name: "friday",
    chat: vi.fn().mockResolvedValue({ content: response, model: "gemini-flash" }),
    stream: vi.fn(),
  } as unknown as Provider
}

function makeDb() {
  const db = openDb(TEST_DB)
  migrate(db)
  return db
}

it("getContext returns system message with empty topic index for new session", async () => {
  const { LayeredStrategy } = await import("./layered.js")
  const db = makeDb()
  const routerProvider = makeProvider(JSON.stringify({ matches: [], confidence: 0 }))
  const strategy = new LayeredStrategy({
    db,
    routerProvider,
    triageProvider: routerProvider,
    systemPrompt: "You are helpful.",
    recentMessageLimit: 20,
    triageAfterTurns: 3,
    compactThresholdBytes: 6144,
    maxActiveTopics: 16,
  })

  await strategy.ensureSession("s1")
  const ctx = await strategy.getContext("s1", "hello")
  expect(ctx.strategyName).toBe("layered")
  expect(ctx.messages[0].role).toBe("system")
})

it("appendTurn persists messages to SQLite", async () => {
  const { LayeredStrategy } = await import("./layered.js")
  const db = makeDb()
  const routerProvider = makeProvider(JSON.stringify({ matches: [], confidence: 0 }))
  const strategy = new LayeredStrategy({
    db,
    routerProvider,
    triageProvider: routerProvider,
    systemPrompt: "You are helpful.",
    recentMessageLimit: 20,
    triageAfterTurns: 3,
    compactThresholdBytes: 6144,
    maxActiveTopics: 16,
  })

  await strategy.ensureSession("s1")
  await strategy.appendTurn(
    "s1",
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  )

  const msgs = db.prepare(`SELECT * FROM chat_messages WHERE session_id = ?`).all("s1") as Array<{ role: string; content: string }>
  expect(msgs).toHaveLength(2)
  expect(msgs[0].role).toBe("user")
  expect(msgs[1].role).toBe("assistant")
})
