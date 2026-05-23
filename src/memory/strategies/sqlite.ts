import { randomUUID } from "crypto"
import type { Message } from "../../providers/types.js"
import type { MemoryStrategy, ConversationContext } from "../strategy.js"
import type { Db } from "../../db/client.js"

interface ChatMessageRow {
  id: number
  session_id: string
  role: string
  content: string
  created_at: string
}

export class SqliteStrategy implements MemoryStrategy {
  readonly name = "sqlite"
  private db: Db
  private limit: number

  constructor(db: Db, limit = 50) {
    this.db = db
    this.limit = limit
  }

  async ensureSession(sessionId: string): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO chat_sessions (id, title, created_at, updated_at)
         VALUES (?, NULL, datetime('now'), datetime('now'))`,
      )
      .run(sessionId)
  }

  async getContext(sessionId: string, _userMessage: string): Promise<ConversationContext> {
    await this.ensureSession(sessionId)

    // Fetch recent messages ordered by id ASC (chronological), limited to last `limit` rows
    const rows = this.db
      .prepare(
        `SELECT id, session_id, role, content, created_at
           FROM chat_messages
          WHERE session_id = ?
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(sessionId, this.limit) as ChatMessageRow[]

    // Reverse to restore chronological order
    const messages: Message[] = rows.reverse().map((row) => ({
      role: row.role as Message["role"],
      content: row.content,
    }))

    return { messages, strategyName: this.name }
  }

  async appendTurn(
    sessionId: string,
    userMsg: { role: "user"; content: string },
    assistantMsg: { role: "assistant"; content: string },
  ): Promise<void> {
    await this.ensureSession(sessionId)

    const insertMsg = this.db.prepare(
      `INSERT INTO chat_messages (session_id, role, content, created_at)
       VALUES (?, ?, ?, datetime('now'))`,
    )

    const updateSession = this.db.prepare(
      `UPDATE chat_sessions
          SET updated_at     = datetime('now'),
              message_count  = message_count + 2
        WHERE id = ?`,
    )

    const insertBoth = this.db.transaction(() => {
      insertMsg.run(sessionId, userMsg.role, typeof userMsg.content === "string" ? userMsg.content : JSON.stringify(userMsg.content))
      insertMsg.run(sessionId, assistantMsg.role, typeof assistantMsg.content === "string" ? assistantMsg.content : JSON.stringify(assistantMsg.content))
      updateSession.run(sessionId)
    })

    insertBoth()
  }
}
