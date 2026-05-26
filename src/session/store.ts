// @ts-nocheck
import { randomUUID } from "crypto";
export class SessionStore {
    db;
    constructor(db) {
        this.db = db;
        this.migrate();
    }
    migrate() {
        // session_meta: per-session key-value store (e.g., agent_mode, uncertainty_cleared)
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_meta (
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        PRIMARY KEY (session_id, key)
      )
    `);
        // 创建 sessions 表（树形，与现有 chat_sessions 独立）
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id                 TEXT PRIMARY KEY,
        parent_session_id  TEXT REFERENCES sessions(id),
        branch_type        TEXT NOT NULL DEFAULT 'main',
        branch_summary     TEXT,
        source             TEXT NOT NULL DEFAULT 'http',
        model              TEXT,
        started_at         INTEGER NOT NULL,
        ended_at           INTEGER,
        end_reason         TEXT,
        message_count      INTEGER NOT NULL DEFAULT 0,
        input_tokens       INTEGER NOT NULL DEFAULT 0,
        output_tokens      INTEGER NOT NULL DEFAULT 0,
        title              TEXT
      )
    `);
        this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_parent
        ON sessions(parent_session_id)
    `);
        this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_source_started
        ON sessions(source, started_at DESC)
    `);
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role          TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
        content       TEXT,
        tool_calls    TEXT,
        tool_call_id  TEXT,
        created_at    INTEGER NOT NULL
      )
    `);
        this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_messages_session
        ON session_messages(session_id, id)
    `);
        // FTS5 — 单独 exec，避免 CREATE TABLE IF NOT EXISTS 与 VIRTUAL TABLE 语法冲突
        // tokenize='trigram' 支持 CJK 3-gram 子串搜索（3字符以上）
        this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts
        USING fts5(
          content,
          content=session_messages,
          content_rowid=id,
          tokenize='trigram'
        )
    `);
        // FTS 触发器
        this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS session_messages_fts_insert
        AFTER INSERT ON session_messages BEGIN
          INSERT INTO session_messages_fts(rowid, content)
            VALUES (new.id, COALESCE(new.content, ''));
        END
    `);
        this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS session_messages_fts_delete
        AFTER DELETE ON session_messages BEGIN
          DELETE FROM session_messages_fts WHERE rowid = old.id;
        END
    `);
        this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS session_messages_fts_update
        AFTER UPDATE ON session_messages BEGIN
          DELETE FROM session_messages_fts WHERE rowid = old.id;
          INSERT INTO session_messages_fts(rowid, content)
            VALUES (new.id, COALESCE(new.content, ''));
        END
    `);
    }
    // -------------------------------------------------------------------------
    // Session 创建
    // -------------------------------------------------------------------------
    /** 创建根节点 session（用户主线对话） */
    create(params) {
        const id = randomUUID();
        const now = Date.now();
        this.db.prepare(`
      INSERT INTO sessions (id, parent_session_id, branch_type, source, model, started_at, title)
      VALUES (?, NULL, 'main', ?, ?, ?, ?)
    `).run(id, params.source, params.model ?? null, now, params.title ?? null);
        return this.get(id);
    }
    /** 创建子 session（支线） */
    branch(parentId, params) {
        // 验证父节点存在
        const parent = this.get(parentId);
        if (!parent)
            throw new Error(`Parent session not found: ${parentId}`);
        const id = randomUUID();
        const now = Date.now();
        this.db.prepare(`
      INSERT INTO sessions (id, parent_session_id, branch_type, source, model, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, parentId, params.branchType, parent.source, params.model ?? parent.model, now);
        return this.get(id);
    }
    // -------------------------------------------------------------------------
    // 支线生命周期
    // -------------------------------------------------------------------------
    /** 支线成功结束，写入 summary，标记 branch_merged */
    mergeBranch(branchId, summary) {
        const now = Date.now();
        this.db.prepare(`
      UPDATE sessions
      SET branch_summary = ?, ended_at = ?, end_reason = 'branch_merged'
      WHERE id = ?
    `).run(summary, now, branchId);
    }
    /** 支线失败废弃，标记 branch_aborted */
    abortBranch(branchId, reason) {
        const now = Date.now();
        this.db.prepare(`
      UPDATE sessions
      SET ended_at = ?, end_reason = 'branch_aborted', branch_summary = ?
      WHERE id = ?
    `).run(now, `aborted: ${reason}`, branchId);
    }
    /** 标记 session 正常结束 */
    end(sessionId, reason = 'done') {
        const now = Date.now();
        this.db.prepare(`
      UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?
    `).run(now, reason, sessionId);
    }
    // -------------------------------------------------------------------------
    // 消息操作
    // -------------------------------------------------------------------------
    /** 追加消息（自动更新 message_count，FTS 由触发器维护） */
    appendMessage(sessionId, msg) {
        const now = Date.now();
        const toolCallsJson = msg.toolCalls ? JSON.stringify(msg.toolCalls) : null;
        const result = this.db.prepare(`
      INSERT INTO session_messages (session_id, role, content, tool_calls, tool_call_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, msg.role, msg.content ?? null, toolCallsJson, msg.toolCallId ?? null, now);
        this.db.prepare(`
      UPDATE sessions SET message_count = message_count + 1 WHERE id = ?
    `).run(sessionId);
        return this.getMessage(result.lastInsertRowid);
    }
    /** 更新 token 使用量 */
    addTokens(sessionId, inputTokens, outputTokens) {
        this.db.prepare(`
      UPDATE sessions
      SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?
      WHERE id = ?
    `).run(inputTokens, outputTokens, sessionId);
    }
    // -------------------------------------------------------------------------
    // 查询
    // -------------------------------------------------------------------------
    get(sessionId) {
        const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
        return row ? this.rowToSession(row) : null;
    }
    getMessage(id) {
        const row = this.db.prepare(`SELECT * FROM session_messages WHERE id = ?`).get(id);
        return row ? this.rowToMessage(row) : null;
    }
    /** 读取 session 的消息历史 */
    getHistory(sessionId, limit = 100) {
        const rows = this.db.prepare(`
      SELECT * FROM session_messages
      WHERE session_id = ?
      ORDER BY id ASC
      LIMIT ?
    `).all(sessionId, limit);
        return rows.map(r => this.rowToMessage(r));
    }
    /** 列出最近的根节点 sessions（branch_type = 'main'，无 parent） */
    listRecent(params = {}) {
        const limit = params.limit ?? 20;
        let sql;
        let args;
        if (params.source) {
            sql = `
        SELECT * FROM sessions
        WHERE parent_session_id IS NULL AND source = ?
        ORDER BY started_at DESC LIMIT ?
      `;
            args = [params.source, limit];
        }
        else {
            sql = `
        SELECT * FROM sessions
        WHERE parent_session_id IS NULL
        ORDER BY started_at DESC LIMIT ?
      `;
            args = [limit];
        }
        const rows = this.db.prepare(sql).all(...args);
        return rows.map(r => this.rowToSession(r));
    }
    /** 读取 session 树（含子节点） */
    getTree(rootId) {
        const session = this.get(rootId);
        if (!session)
            return null;
        const childRows = this.db.prepare(`
      SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY started_at ASC
    `).all(rootId);
        const children = childRows.map(r => {
            const child = this.rowToSession(r);
            return this.getTree(child.id);
        });
        return { session, children };
    }
    /** FTS5 全文搜索（跨所有 sessions） */
    search(query, limit = 20) {
        // FTS5 trigram 支持中文子串搜索
        const rows = this.db.prepare(`
      SELECT
        sm.id as message_id,
        sm.session_id,
        sm.role,
        sm.content,
        sm.created_at,
        rank
      FROM session_messages_fts fts
      JOIN session_messages sm ON sm.id = fts.rowid
      WHERE session_messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit);
        return rows.map(r => ({
            messageId: r['message_id'],
            sessionId: r['session_id'],
            role: r['role'],
            content: r['content'],
            createdAt: r['created_at'],
            rank: r['rank'],
        }));
    }
    /** 更新 session 标题 */
    setTitle(sessionId, title) {
        this.db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, sessionId);
    }
    // -------------------------------------------------------------------------
    // Session meta (key-value per session)
    // -------------------------------------------------------------------------
    getMeta(sessionId, key) {
        const row = this.db.prepare(`SELECT value FROM session_meta WHERE session_id = ? AND key = ?`).get(sessionId, key);
        return row?.value ?? null;
    }
    setMeta(sessionId, key, value) {
        this.db.prepare(`
      INSERT INTO session_meta (session_id, key, value)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value
    `).run(sessionId, key, value);
    }
    deleteMeta(sessionId, key) {
        this.db.prepare(`DELETE FROM session_meta WHERE session_id = ? AND key = ?`).run(sessionId, key);
    }
    // -------------------------------------------------------------------------
    // 私有辅助
    // -------------------------------------------------------------------------
    rowToSession(row) {
        return {
            id: row['id'],
            parentSessionId: row['parent_session_id'],
            branchType: row['branch_type'],
            branchSummary: row['branch_summary'],
            source: row['source'],
            model: row['model'],
            startedAt: row['started_at'],
            endedAt: row['ended_at'],
            endReason: row['end_reason'],
            messageCount: row['message_count'],
            inputTokens: row['input_tokens'],
            outputTokens: row['output_tokens'],
            title: row['title'],
        };
    }
    rowToMessage(row) {
        return {
            id: row['id'],
            sessionId: row['session_id'],
            role: row['role'],
            content: row['content'],
            toolCalls: row['tool_calls'],
            toolCallId: row['tool_call_id'],
            createdAt: row['created_at'],
        };
    }
}
