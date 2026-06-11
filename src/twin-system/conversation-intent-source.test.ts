import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import type { Db } from "../db/client.js"
import { ConversationIntentSource } from "./conversation-intent-source.js"

function makeDb(): Db {
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
  `)
  return db
}

function addSession(db: Db, id: string, title: string): void {
  db.prepare(`INSERT INTO chat_sessions (id, title, message_count) VALUES (?, ?, 0)`).run(id, title)
}

function addMsg(db: Db, sessionId: string, role: string, content: string): void {
  db.prepare(`INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)`).run(
    sessionId,
    role,
    content,
  )
}

describe("ConversationIntentSource", () => {
  let db: Db

  beforeEach(() => {
    db = makeDb()
  })

  it("returns no intents when there are no conversations", () => {
    const src = new ConversationIntentSource(db)
    expect(src.generate()).toEqual([])
  })

  it("does NOT flag a healthy conversation", () => {
    addSession(db, "s-good", "good chat")
    addMsg(db, "s-good", "user", "Can you explain how the router works in detail?")
    addMsg(
      db,
      "s-good",
      "assistant",
      "Sure. The router resolves the primary provider first, then falls back in order. " +
        "It tracks failures and retries with exponential backoff, ensuring resilience across providers.",
    )
    const src = new ConversationIntentSource(db, {}, { sessionIds: ["s-good"] })
    expect(src.generate()).toEqual([])
  })

  it("flags a conversation with many short responses and includes the transcript", () => {
    addSession(db, "s-bad", "broken chat")
    addMsg(db, "s-bad", "user", "Please write a function that parses JSON safely")
    addMsg(db, "s-bad", "assistant", "ok")
    addMsg(db, "s-bad", "user", "that didn't work, try again")
    addMsg(db, "s-bad", "assistant", "done")

    const src = new ConversationIntentSource(db, {}, { sessionIds: ["s-bad"] })
    const intents = src.generate()
    expect(intents.length).toBe(1)
    const intent = intents[0]
    expect(intent.type).toBe("behavior_fix")
    // transcript must be embedded so the mutator has a concrete anchor
    expect(intent.description).toContain("Conversation transcript")
    expect(intent.description).toContain("parses JSON safely")
    expect(intent.dedupKey).toBe("conversation:s-bad")
    expect(intent.evidence.some((e) => e.includes("s-bad"))).toBe(true)
  })

  it("flags error/refusal markers and escalates risk to medium when repeated", () => {
    addSession(db, "s-err", "errors")
    addMsg(db, "s-err", "user", "deploy the service to production environment now")
    addMsg(db, "s-err", "assistant", "Sorry, I cannot do that because of an error in the pipeline.")
    addMsg(db, "s-err", "user", "why not, please retry the deployment")
    addMsg(db, "s-err", "assistant", "I am unable to proceed, the operation failed again.")

    const src = new ConversationIntentSource(db, {}, { sessionIds: ["s-err"] })
    const intents = src.generate()
    expect(intents.length).toBe(1)
    expect(intents[0].riskLevel).toBe("medium")
  })

  it("respects the keyword filter", () => {
    addSession(db, "s1", "a")
    addMsg(db, "s1", "user", "talk about kubernetes deployment")
    addMsg(db, "s1", "assistant", "no")
    addSession(db, "s2", "b")
    addMsg(db, "s2", "user", "talk about databases")
    addMsg(db, "s2", "assistant", "no")

    const src = new ConversationIntentSource(db, {}, { keyword: "kubernetes" })
    const intents = src.generate()
    expect(intents.length).toBe(1)
    expect(intents[0].dedupKey).toBe("conversation:s1")
  })

  it("caps the number of intents via maxIntents", () => {
    for (let i = 0; i < 5; i++) {
      addSession(db, `bad-${i}`, `bad ${i}`)
      addMsg(db, `bad-${i}`, "user", `please help me with task number ${i} carefully`)
      addMsg(db, `bad-${i}`, "assistant", "no")
    }
    const src = new ConversationIntentSource(db, {}, { maxIntents: 2 })
    expect(src.generate().length).toBe(2)
  })

  it("truncates the transcript to maxSampleMessages", () => {
    addSession(db, "s-long", "long")
    for (let i = 0; i < 20; i++) {
      addMsg(db, "s-long", "user", `question ${i} about the system behavior please`)
      addMsg(db, "s-long", "assistant", "no")
    }
    const src = new ConversationIntentSource(db, {}, { sessionIds: ["s-long"], maxSampleMessages: 4 })
    const intents = src.generate()
    expect(intents.length).toBe(1)
    expect(intents[0].description).toContain("earlier message(s) omitted")
  })
})
