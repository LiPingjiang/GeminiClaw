/**
 * Tests for ConversationCandidateSource.
 *
 * The source no longer does heuristic *quality scoring* (that judgement moved
 * to the reflector's LLM call). It now does two things:
 *   1. A cheap coarse filter — drop obvious stubs by message count.
 *   2. Whole-conversation compression — give the reflector the full task
 *      (head + summarised/skeletonised middle + tail), not a tail fragment.
 *
 * These tests run WITHOUT an LLM, so compression falls back to the structural
 * skeleton path (no network), which is the deterministic behaviour we assert.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { ConversationCandidateSource } from "./conversation-candidate-source.js"
import type { Db } from "../db/client.js"

function makeDb(): Db {
  const db = new Database(":memory:") as Db
  db.exec(`
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      message_count INTEGER DEFAULT 0,
      updated_at TEXT,
      created_at TEXT
    );
    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      role TEXT,
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      created_at TEXT
    );
  `)
  return db
}

function addSession(db: Db, id: string, title: string, when: string): void {
  db.prepare(
    "INSERT INTO chat_sessions (id, title, message_count, updated_at, created_at) VALUES (?, ?, 0, ?, ?)",
  ).run(id, title, when, when)
}

function addMsg(db: Db, sessionId: string, role: string, content: string, when: string): void {
  db.prepare(
    "INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
  ).run(sessionId, role, content, when)
}

/** Add a conversation of `turns` user+assistant pairs (2*turns messages). */
function addConversation(db: Db, id: string, title: string, turns: number, when: string): void {
  addSession(db, id, title, when)
  for (let i = 0; i < turns; i++) {
    addMsg(db, id, "user", `user turn ${i}: please do a non-trivial step here`, when)
    addMsg(db, id, "assistant", `assistant turn ${i}: a reasonably detailed answer`, when)
  }
}

const NOW = new Date().toISOString().replace("T", " ").slice(0, 19)

describe("ConversationCandidateSource", () => {
  let db: Db

  beforeEach(() => {
    db = makeDb()
  })

  afterEach(() => {
    db.close()
  })

  it("returns empty when there are no sessions", async () => {
    const source = new ConversationCandidateSource(db)
    expect(await source.collect()).toEqual([])
  })

  it("drops stub conversations below the minMessages threshold", async () => {
    // 2 messages → below default minMessages (4) → filtered out.
    addSession(db, "stub", "Quick hi", NOW)
    addMsg(db, "stub", "user", "hi", NOW)
    addMsg(db, "stub", "assistant", "hello", NOW)

    const source = new ConversationCandidateSource(db)
    const candidates = await source.collect()
    expect(candidates).toEqual([])
  })

  it("keeps conversations that clear the minMessages threshold", async () => {
    addConversation(db, "real", "Real task", 4, NOW) // 8 messages
    const source = new ConversationCandidateSource(db)
    const candidates = await source.collect()
    expect(candidates.length).toBe(1)
    expect(candidates[0].sessionId).toBe("real")
    expect(candidates[0].transcript).toContain("[assistant]")
    // No pre-judged problems anymore.
    expect(candidates[0].problems).toEqual([])
  })

  it("renders short conversations whole (no compression marker)", async () => {
    addConversation(db, "short", "Short task", 5, NOW) // 10 msgs < threshold(40)
    const source = new ConversationCandidateSource(db)
    const [candidate] = await source.collect()
    expect(candidate.transcript).not.toContain("middle of conversation compressed")
    // Every turn should be present.
    expect(candidate.transcript).toContain("user turn 0")
    expect(candidate.transcript).toContain("user turn 4")
  })

  it("compresses the middle of long conversations (head + marker + tail)", async () => {
    // 60 turns → 120 messages, well above compressionThreshold(40).
    addConversation(db, "long", "Long task", 60, NOW)
    const source = new ConversationCandidateSource(db) // no LLM → skeleton middle
    const [candidate] = await source.collect()
    expect(candidate.transcript).toContain("middle of conversation compressed")
    // Head is protected: the very first turn survives verbatim.
    expect(candidate.transcript).toContain("user turn 0")
    // Tail is protected: the very last turn survives verbatim.
    expect(candidate.transcript).toContain("assistant turn 59")
  })

  it("uses the injected LLM to summarise long middles (below segmentation threshold)", async () => {
    // 50 turns → 100 messages: above compressionThreshold(40) but BELOW the
    // taskSegmentationThreshold, so it stays on the single-candidate compress
    // path and the LLM is used to summarise the middle.
    addConversation(db, "long", "Long task", 50, NOW)
    let called = false
    const fakeLlm = {
      async chat(): Promise<string> {
        called = true
        return "MIDDLE-SUMMARY-SENTINEL"
      },
    }
    const source = new ConversationCandidateSource(
      db,
      { taskSegmentationThreshold: 1000 },
      {},
      fakeLlm,
    )
    const [candidate] = await source.collect()
    expect(called).toBe(true)
    expect(candidate.transcript).toContain("MIDDLE-SUMMARY-SENTINEL")
    expect(candidate.task).toBeUndefined()
  })

  it("decomposes a long session into one candidate per task", async () => {
    // 80 turns → 160 messages, above the (lowered) segmentation threshold.
    addConversation(db, "multi", "Multi-task session", 80, NOW)

    // Stub LLM that returns two tasks splitting the id range in half. Message
    // ids are 1..160; user turns are the odd ids 1,3,...,159.
    const fakeLlm = {
      async chat(): Promise<string> {
        return [
          "TASK|1|1|80|40|first half::a",
          "TASK|2|81|160|40|second half::b",
        ].join("\n")
      },
    }

    const source = new ConversationCandidateSource(
      db,
      { taskSegmentationThreshold: 100 },
      {},
      fakeLlm,
    )
    const candidates = await source.collect()

    expect(candidates.length).toBe(2)
    expect(candidates[0].task?.index).toBe(1)
    expect(candidates[0].task?.total).toBe(2)
    expect(candidates[1].task?.index).toBe(2)
    expect(candidates.every((c) => c.sessionId === "multi")).toBe(true)
    // Each candidate's transcript covers only its own id slice → both non-empty.
    expect(candidates[0].transcript.length).toBeGreaterThan(0)
    expect(candidates[1].transcript.length).toBeGreaterThan(0)
  })

  it("falls back to whole-session compression when segmentation yields nothing", async () => {
    addConversation(db, "fallback", "Fallback session", 80, NOW)
    // LLM returns no parseable TASK lines → collectTaskCandidates returns []
    // → whole-session fallback.
    const emptyLlm = {
      async chat(): Promise<string> {
        return "（没有可识别的任务）"
      },
    }
    const source = new ConversationCandidateSource(
      db,
      { taskSegmentationThreshold: 100 },
      {},
      emptyLlm,
    )
    const candidates = await source.collect()
    expect(candidates.length).toBe(1)
    expect(candidates[0].task).toBeUndefined()
  })

  it("respects maxCandidates", async () => {
    addConversation(db, "c1", "One", 4, NOW)
    addConversation(db, "c2", "Two", 4, NOW)
    addConversation(db, "c3", "Three", 4, NOW)
    const source = new ConversationCandidateSource(db, { maxCandidates: 2 })
    const candidates = await source.collect()
    expect(candidates.length).toBe(2)
  })

  it("filters by explicit sessionIds", async () => {
    addConversation(db, "a", "A", 4, NOW)
    addConversation(db, "b", "B", 4, NOW)
    const source = new ConversationCandidateSource(db, undefined, { sessionIds: ["b"] })
    const candidates = await source.collect()
    expect(candidates.map((c) => c.sessionId)).toEqual(["b"])
  })

  it("filters by keyword", async () => {
    addSession(db, "k1", "K1", NOW)
    for (let i = 0; i < 4; i++) addMsg(db, "k1", "user", "deploy to kubernetes please now", NOW)
    addSession(db, "k2", "K2", NOW)
    for (let i = 0; i < 4; i++) addMsg(db, "k2", "user", "something else entirely here ok", NOW)

    const source = new ConversationCandidateSource(db, undefined, { keyword: "kubernetes" })
    const candidates = await source.collect()
    expect(candidates.map((c) => c.sessionId)).toEqual(["k1"])
  })
})
