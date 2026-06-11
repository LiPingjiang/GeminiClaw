/**
 * Tests for intent sources: TraceIntentSource, MemoryIntentSource, UpstreamIntentSource
 */
import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import type { Db } from "../db/client.js"
import { TraceIntentSource, MemoryIntentSource, UpstreamIntentSource } from "./intent-sources.js"
import type { UpstreamTracker } from "./upstream-tracker.js"
import type { EvolutionIntent } from "./types.js"

function createTestDb(): Db {
  const db = new Database(":memory:") as unknown as Db
  db.exec(`
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      message_count INTEGER NOT NULL DEFAULT 0,
      topic_ids TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE public_knowledge (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT,
      doc_level2 TEXT,
      doc_level3 TEXT,
      doc_size INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
      access_count INTEGER NOT NULL DEFAULT 0
    );
  `)
  return db
}

// ── TraceIntentSource Tests ──────────────────────────────────────────────────

describe("TraceIntentSource", () => {
  let db: Db

  beforeEach(() => {
    db = createTestDb()
  })

  it("returns empty when no messages exist", () => {
    const source = new TraceIntentSource(db)
    const intents = source.generate()
    expect(intents).toEqual([])
  })

  it("returns empty when not enough messages for analysis", () => {
    const source = new TraceIntentSource(db, { minSessionsForAnalysis: 10 })
    // Insert only 3 messages
    const now = new Date().toISOString().replace("T", " ").slice(0, 19)
    const stmt = db.prepare("INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)")
    stmt.run("s1", "assistant", "hi", now)
    stmt.run("s1", "assistant", "hello there!", now)
    stmt.run("s1", "assistant", "ok", now)
    const intents = source.generate()
    expect(intents).toEqual([])
  })

  it("detects high short-response rate", () => {
    const source = new TraceIntentSource(db, {
      minSessionsForAnalysis: 3,
      errorRateThreshold: 0.3,
      shortResponseThreshold: 50,
      lookbackMs: 60 * 60 * 1000,
    })

    const now = new Date().toISOString().replace("T", " ").slice(0, 19)
    const stmt = db.prepare("INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)")
    // 4 short responses, 1 long → 80% short rate
    stmt.run("s1", "assistant", "ok", now)
    stmt.run("s1", "assistant", "yes", now)
    stmt.run("s1", "assistant", "no", now)
    stmt.run("s1", "assistant", "hmm", now)
    stmt.run("s1", "assistant", "This is a much longer response that exceeds the 50 character threshold easily.", now)

    const intents = source.generate()
    expect(intents.length).toBeGreaterThanOrEqual(1)
    const shortIntent = intents.find((i) => i.dedupKey === "trace:short-responses")
    expect(shortIntent).toBeDefined()
    expect(shortIntent!.type).toBe("behavior_fix")
    expect(shortIntent!.riskLevel).toBe("medium")
  })

  it("detects repeated user messages", () => {
    const source = new TraceIntentSource(db, {
      minSessionsForAnalysis: 1,
      errorRateThreshold: 0.9, // won't trigger short-response
      shortResponseThreshold: 5,
      lookbackMs: 60 * 60 * 1000,
    })

    const now = new Date().toISOString().replace("T", " ").slice(0, 19)
    const stmt = db.prepare("INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)")
    // Repeat same message 4 times
    for (let i = 0; i < 4; i++) {
      stmt.run(`s${i}`, "user", "how do I fix the login bug?", now)
    }
    // Some normal messages
    stmt.run("s5", "user", "tell me about the weather", now)
    stmt.run("s5", "assistant", "The weather is fine today with clear skies and sunshine!", now)

    const intents = source.generate()
    const repIntent = intents.find((i) => i.dedupKey?.startsWith("trace:repetition:"))
    expect(repIntent).toBeDefined()
    expect(repIntent!.type).toBe("behavior_fix")
    expect(repIntent!.description).toContain("4 times")
  })

  it("does not trigger below threshold", () => {
    const source = new TraceIntentSource(db, {
      minSessionsForAnalysis: 3,
      errorRateThreshold: 0.5,
      shortResponseThreshold: 50,
      lookbackMs: 60 * 60 * 1000,
    })

    const now = new Date().toISOString().replace("T", " ").slice(0, 19)
    const stmt = db.prepare("INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)")
    // 2 short, 4 long → 33% short rate (below 50% threshold)
    stmt.run("s1", "assistant", "ok", now)
    stmt.run("s1", "assistant", "yes", now)
    stmt.run("s1", "assistant", "This is a detailed response that helps the user understand the concept.", now)
    stmt.run("s1", "assistant", "Here's another thorough explanation with all the details you need.", now)
    stmt.run("s1", "assistant", "Let me provide comprehensive information about this topic for you.", now)
    stmt.run("s1", "assistant", "The solution involves several steps that I'll explain in detail below.", now)

    const intents = source.generate()
    const shortIntent = intents.find((i) => i.dedupKey === "trace:short-responses")
    expect(shortIntent).toBeUndefined()
  })
})

// ── MemoryIntentSource Tests ─────────────────────────────────────────────────

describe("MemoryIntentSource", () => {
  let db: Db

  beforeEach(() => {
    db = createTestDb()
  })

  it("returns empty when no topics exist", () => {
    const source = new MemoryIntentSource(db)
    const intents = source.generate()
    expect(intents).toEqual([])
  })

  it("detects hot topics without summary", () => {
    const source = new MemoryIntentSource(db, { hotTopicThreshold: 5 })

    const stmt = db.prepare(
      "INSERT INTO public_knowledge (id, title, active, access_count, summary) VALUES (?, ?, 1, ?, ?)",
    )
    stmt.run("t1", "TypeScript Patterns", 25, null)
    stmt.run("t2", "API Design", 30, null)
    stmt.run("t3", "Has Summary", 50, "This topic is well summarized")

    const intents = source.generate()
    const hotIntent = intents.find((i) => i.dedupKey === "memory:hot-topics-no-summary")
    expect(hotIntent).toBeDefined()
    expect(hotIntent!.type).toBe("optimization")
    expect(hotIntent!.evidence.length).toBe(2) // t1 and t2
  })

  it("detects stale topics", () => {
    const source = new MemoryIntentSource(db, { staleDaysThreshold: 7 })

    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    const stmt = db.prepare(
      "INSERT INTO public_knowledge (id, title, active, last_accessed_at, access_count) VALUES (?, ?, 1, ?, 1)",
    )
    stmt.run("t1", "Old Topic 1", oldDate)
    stmt.run("t2", "Old Topic 2", oldDate)
    stmt.run("t3", "Old Topic 3", oldDate)
    stmt.run("t4", "Old Topic 4", oldDate)

    const intents = source.generate()
    const staleIntent = intents.find((i) => i.dedupKey === "memory:stale-topics")
    expect(staleIntent).toBeDefined()
    expect(staleIntent!.type).toBe("optimization")
    expect(staleIntent!.description).toContain("4 stale topics")
  })

  it("detects topic count pressure", () => {
    const source = new MemoryIntentSource(db, { topicCountWarningThreshold: 3 })

    const stmt = db.prepare(
      "INSERT INTO public_knowledge (id, title, active, access_count) VALUES (?, ?, 1, 1)",
    )
    stmt.run("t1", "Topic 1")
    stmt.run("t2", "Topic 2")
    stmt.run("t3", "Topic 3")
    stmt.run("t4", "Topic 4")

    const intents = source.generate()
    const pressureIntent = intents.find((i) => i.dedupKey === "memory:topic-pressure")
    expect(pressureIntent).toBeDefined()
    expect(pressureIntent!.description).toContain("4")
  })

  it("does not trigger below thresholds", () => {
    const source = new MemoryIntentSource(db, {
      hotTopicThreshold: 100,
      staleDaysThreshold: 365,
      topicCountWarningThreshold: 100,
    })

    const stmt = db.prepare(
      "INSERT INTO public_knowledge (id, title, active, access_count, summary) VALUES (?, ?, 1, 5, 'ok')",
    )
    stmt.run("t1", "Topic 1")
    stmt.run("t2", "Topic 2")

    const intents = source.generate()
    expect(intents).toEqual([])
  })
})

// ── UpstreamIntentSource Tests ───────────────────────────────────────────────

describe("UpstreamIntentSource", () => {
  it("drains intents from upstream tracker", () => {
    const mockIntents: EvolutionIntent[] = [
      {
        id: "us_abc",
        type: "upstream_sync",
        description: "[OpenClaw] Add streaming support",
        targetFiles: ["src/providers/router.ts"],
        evidence: ["Relevance: 0.8", "From 3 upstream commit(s)"],
        riskLevel: "medium",
        requiresHumanApproval: true,
        createdAt: Date.now(),
      },
    ]

    const mockTracker = {
      drainIntents: () => mockIntents,
    } as unknown as UpstreamTracker

    const source = new UpstreamIntentSource(mockTracker)
    expect(source.name).toBe("upstream-sync")

    const intents = source.generate()
    expect(intents).toHaveLength(1)
    expect(intents[0].type).toBe("upstream_sync")
    expect(intents[0].description).toBe("[OpenClaw] Add streaming support")
    expect(intents[0].riskLevel).toBe("medium")
    expect(intents[0].dedupKey).toContain("upstream:")
  })

  it("returns empty when tracker has no intents", () => {
    const mockTracker = {
      drainIntents: () => [],
    } as unknown as UpstreamTracker

    const source = new UpstreamIntentSource(mockTracker)
    const intents = source.generate()
    expect(intents).toEqual([])
  })

  it("maps multiple upstream intents", () => {
    const mockIntents: EvolutionIntent[] = [
      {
        id: "us_1",
        type: "upstream_sync",
        description: "[Hermes] Refactor config",
        targetFiles: ["src/config/loader.ts"],
        evidence: ["Relevance: 0.9"],
        riskLevel: "low",
        requiresHumanApproval: false,
        createdAt: Date.now(),
      },
      {
        id: "us_2",
        type: "upstream_sync",
        description: "[Hermes] New provider API",
        targetFiles: ["src/providers/types.ts"],
        evidence: ["Relevance: 0.7"],
        riskLevel: "high",
        requiresHumanApproval: true,
        createdAt: Date.now(),
      },
    ]

    const mockTracker = {
      drainIntents: () => mockIntents,
    } as unknown as UpstreamTracker

    const source = new UpstreamIntentSource(mockTracker)
    const intents = source.generate()
    expect(intents).toHaveLength(2)
    expect(intents[0].riskLevel).toBe("low")
    expect(intents[1].riskLevel).toBe("high")
  })
})
