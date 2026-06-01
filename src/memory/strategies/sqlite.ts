// @ts-nocheck
export class SqliteStrategy {
    name = "sqlite";
    db;
    limit;
    constructor(db, limit = 50) {
        this.db = db;
        this.limit = limit;
    }
    async ensureSession(sessionId) {
        this.db
            .prepare(`INSERT OR IGNORE INTO chat_sessions (id, title, created_at, updated_at)
         VALUES (?, NULL, datetime('now'), datetime('now'))`)
            .run(sessionId);
    }
    async getContext(sessionId, _userMessage) {
        await this.ensureSession(sessionId);
        // Fetch recent messages ordered by id ASC (chronological), limited to last `limit` rows
        const rows = this.db
            .prepare(`SELECT id, session_id, role, content, tool_calls, tool_call_id, created_at
           FROM chat_messages
          WHERE session_id = ?
          ORDER BY id DESC
          LIMIT ?`)
            .all(sessionId, this.limit);
        // Reverse to restore chronological order
        const messages = rows.reverse().map((row) => {
            const msg = {
                role: row.role,
                content: row.content,
            };
            if (row.tool_calls) {
                try {
                    msg.tool_calls = JSON.parse(row.tool_calls);
                }
                catch { /* ignore */ }
            }
            if (row.tool_call_id) {
                msg.tool_call_id = row.tool_call_id;
            }
            return msg;
        });
        return { messages, strategyName: this.name };
    }
    async appendTurn(sessionId, userMsg, assistantMsg) {
        await this.ensureSession(sessionId);
        const insertMsg = this.db.prepare(`INSERT INTO chat_messages (session_id, role, content, created_at)
       VALUES (?, ?, ?, datetime('now'))`);
        const updateSession = this.db.prepare(`UPDATE chat_sessions
          SET updated_at     = datetime('now'),
              message_count  = message_count + 2
        WHERE id = ?`);
        const insertBoth = this.db.transaction(() => {
            insertMsg.run(sessionId, userMsg.role, typeof userMsg.content === "string" ? userMsg.content : JSON.stringify(userMsg.content));
            insertMsg.run(sessionId, assistantMsg.role, typeof assistantMsg.content === "string" ? assistantMsg.content : JSON.stringify(assistantMsg.content));
            updateSession.run(sessionId);
        });
        insertBoth();
    }
    async appendMessages(sessionId, messages) {
        await this.ensureSession(sessionId);
        const insertMsg = this.db.prepare(`INSERT INTO chat_messages (session_id, role, content, tool_calls, tool_call_id, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`);
        const updateSession = this.db.prepare(`UPDATE chat_sessions
          SET updated_at    = datetime('now'),
              message_count = message_count + ?
        WHERE id = ?`);
        const insertAll = this.db.transaction(() => {
            for (const msg of messages) {
                const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
                const toolCalls = msg.tool_calls ? JSON.stringify(msg.tool_calls) : null;
                const toolCallId = msg.tool_call_id ?? null;
                insertMsg.run(sessionId, msg.role, content, toolCalls, toolCallId);
            }
            updateSession.run(messages.length, sessionId);
        });
        insertAll();
    }
}
