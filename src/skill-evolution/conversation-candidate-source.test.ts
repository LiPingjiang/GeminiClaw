/**
 * Tests for ConversationCandidateSource — scoring real conversations.
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

function addMsg(
  db: Db,
  sessionId: string,
  role: string,
  content: string,
  when: string,
): void {
  db.prepare(
    "INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
  ).run(sessionId, role, content, when)
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

  it("returns empty when there are no sessions", () => {
    const source = new ConversationCandidateSource(db)
    expect(source.collect()).toEqual([])
  })

  it("flags conversations with error markers", () => {
    addSession(db, "s1", "Broken build", NOW)
    addMsg(db, "s1", "user", "please fix my build it is broken right now ok", NOW)
    addMsg(db, "s1", "assistant", "Sorry, the build failed with an error.", NOW)

    const source = new ConversationCandidateSource(db)
    const candidates = source.collect()
    expect(candidates.length).toBe(1)
    expect(candidates[0].sessionId).toBe("s1")
    expect(candidates[0].problems.join(" ")).toMatch(/error\/refusal markers/)
    expect(candidates[0].transcript).toContain("[assistant]")
  })

  it("flags rich multi-step conversations as skill candidates", () => {
    addSession(db, "rich", "Big task", NOW)
    for (let i = 0; i < 6; i++) {
      addMsg(db, "rich", "user", `step ${i} please do this longer instruction`, NOW)
      addMsg(db, "rich", "assistant", `Here is a detailed answer for step ${i} `.repeat(5), NOW)
    }

    const source = new ConversationCandidateSource(db)
    const candidates = source.collect()
    expect(candidates.length).toBe(1)
    expect(candidates[0].problems.join(" ")).toMatch(/Rich multi-step/)
  })

  it("respects maxCandidates and sorts by score", () => {
    // High-score session: errors + rich.
    addSession(db, "hi", "High", NOW)
    for (let i = 0; i < 6; i++) {
      addMsg(db, "hi", "user", `do task ${i} with a sufficiently long instruction`, NOW)
    }
    addMsg(db, "hi", "assistant", "error: failed badly", NOW)
    addMsg(db, "hi", "assistant", "sorry unable to", NOW)
    // Low-score session: single error.
    addSession(db, "lo", "Low", NOW)
    addMsg(db, "lo", "user", "a question that is long enough to count here ok", NOW)
    addMsg(db, "lo", "assistant", "error happened", NOW)

    const source = new ConversationCandidateSource(db, { maxCandidates: 1 })
    const candidates = source.collect()
    expect(candidates.length).toBe(1)
    expect(candidates[0].sessionId).toBe("hi")
  })

  it("filters by explicit sessionIds", () => {
    addSession(db, "a", "A", NOW)
    addMsg(db, "a", "assistant", "error here", NOW)
    addSession(db, "b", "B", NOW)
    addMsg(db, "b", "assistant", "error there", NOW)

    const source = new ConversationCandidateSource(db, undefined, { sessionIds: ["b"] })
    const candidates = source.collect()
    expect(candidates.map((c) => c.sessionId)).toEqual(["b"])
  })

  it("filters by keyword", () => {
    addSession(db, "k1", "K1", NOW)
    addMsg(db, "k1", "assistant", "error about kubernetes deployment", NOW)
    addSession(db, "k2", "K2", NOW)
    addMsg(db, "k2", "assistant", "error about something else entirely", NOW)

    const source = new ConversationCandidateSource(db, undefined, { keyword: "kubernetes" })
    const candidates = source.collect()
    expect(candidates.map((c) => c.sessionId)).toEqual(["k1"])
  })
})
