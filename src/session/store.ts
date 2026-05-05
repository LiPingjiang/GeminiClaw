import { randomUUID } from "crypto"
import type { Db } from "../db/client.js"

// Session 树节点
export interface Session {
  id: string
  parentSessionId: string | null      // NULL = 根节点
  branchType: 'main' | 'evolution' | 'subagent' | 'compress'
  branchSummary: string | null        // 支线结束时写入
  source: string                      // 'http' | 'qqbot' | 'cli' | 'test'
  model: string | null
  startedAt: number                   // Unix ms
  endedAt: number | null
  endReason: string | null            // 'done' | 'compress' | 'branch_merged' | 'branch_aborted'
  messageCount: number
  inputTokens: number
  outputTokens: number
  title: string | null
}

export interface StoredMessage {
  id: number
  sessionId: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string | null
  toolCalls: string | null            // JSON
  toolCallId: string | null
  createdAt: number                   // Unix ms
}

export interface SearchResult {
  messageId: number
  sessionId: string
  role: string
  content: string
  createdAt: number
  rank: number
}

export interface SessionTree {
  session: Session
  children: SessionTree[]
}

export class SessionStore {
  private db: Db

  constructor(db: Db) {
    this.db = db
    this.migrate()
  }

  private migrate(): void {
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
    `)

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_parent
        ON sessions(parent_session_id)
    `)

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_source_started
        ON sessions(source, started_at DESC)
    `)

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
    `)

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_messages_session
        ON session_messages(session_id, id)
    `)

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
    `)

    // FTS 触发器
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS session_messages_fts_insert
        AFTER INSERT ON session_messages BEGIN
          INSERT INTO session_messages_fts(rowid, content)
            VALUES (new.id, COALESCE(new.content, ''));
        END
    `)

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS session_messages_fts_delete
        AFTER DELETE ON session_messages BEGIN
          DELETE FROM session_messages_fts WHERE rowid = old.id;
        END
    `)

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS session_messages_fts_update
        AFTER UPDATE ON session_messages BEGIN
          DELETE FROM session_messages_fts WHERE rowid = old.id;
          INSERT INTO session_messages_fts(rowid, content)
            VALUES (new.id, COALESCE(new.content, ''));
        END
    `)
  }

  // -------------------------------------------------------------------------
  // Session 创建
  // -------------------------------------------------------------------------

  /** 创建根节点 session（用户主线对话） */
  create(params: {
    source: string
    model?: string
    title?: string
  }): Session {
    const id = randomUUID()
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO sessions (id, parent_session_id, branch_type, source, model, started_at, title)
      VALUES (?, NULL, 'main', ?, ?, ?, ?)
    `).run(id, params.source, params.model ?? null, now, params.title ?? null)
    return this.get(id)!
  }

  /** 创建子 session（支线） */
  branch(parentId: string, params: {
    branchType: 'evolution' | 'subagent' | 'compress'
    model?: string
  }): Session {
    // 验证父节点存在
    const parent = this.get(parentId)
    if (!parent) throw new Error(`Parent session not found: ${parentId}`)

    const id = randomUUID()
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO sessions (id, parent_session_id, branch_type, source, model, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, parentId, params.branchType, parent.source, params.model ?? parent.model, now)
    return this.get(id)!
  }

  // -------------------------------------------------------------------------
  // 支线生命周期
  // -------------------------------------------------------------------------

  /** 支线成功结束，写入 summary，标记 branch_merged */
  mergeBranch(branchId: string, summary: string): void {
    const now = Date.now()
    this.db.prepare(`
      UPDATE sessions
      SET branch_summary = ?, ended_at = ?, end_reason = 'branch_merged'
      WHERE id = ?
    `).run(summary, now, branchId)
  }

  /** 支线失败废弃，标记 branch_aborted */
  abortBranch(branchId: string, reason: string): void {
    const now = Date.now()
    this.db.prepare(`
      UPDATE sessions
      SET ended_at = ?, end_reason = 'branch_aborted', branch_summary = ?
      WHERE id = ?
    `).run(now, `aborted: ${reason}`, branchId)
  }

  /** 标记 session 正常结束 */
  end(sessionId: string, reason: 'done' | 'compress' = 'done'): void {
    const now = Date.now()
    this.db.prepare(`
      UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?
    `).run(now, reason, sessionId)
  }

  // -------------------------------------------------------------------------
  // 消息操作
  // -------------------------------------------------------------------------

  /** 追加消息（自动更新 message_count，FTS 由触发器维护） */
  appendMessage(sessionId: string, msg: {
    role: 'user' | 'assistant' | 'tool' | 'system'
    content?: string
    toolCalls?: unknown
    toolCallId?: string
  }): StoredMessage {
    const now = Date.now()
    const toolCallsJson = msg.toolCalls ? JSON.stringify(msg.toolCalls) : null
    const result = this.db.prepare(`
      INSERT INTO session_messages (session_id, role, content, tool_calls, tool_call_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, msg.role, msg.content ?? null, toolCallsJson, msg.toolCallId ?? null, now)

    this.db.prepare(`
      UPDATE sessions SET message_count = message_count + 1 WHERE id = ?
    `).run(sessionId)

    return this.getMessage(result.lastInsertRowid as number)!
  }

  /** 更新 token 使用量 */
  addTokens(sessionId: string, inputTokens: number, outputTokens: number): void {
    this.db.prepare(`
      UPDATE sessions
      SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?
      WHERE id = ?
    `).run(inputTokens, outputTokens, sessionId)
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  get(sessionId: string): Session | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as Record<string, unknown> | undefined
    return row ? this.rowToSession(row) : null
  }

  getMessage(id: number): StoredMessage | null {
    const row = this.db.prepare(`SELECT * FROM session_messages WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? this.rowToMessage(row) : null
  }

  /** 读取 session 的消息历史 */
  getHistory(sessionId: string, limit = 100): StoredMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM session_messages
      WHERE session_id = ?
      ORDER BY id ASC
      LIMIT ?
    `).all(sessionId, limit) as Record<string, unknown>[]
    return rows.map(r => this.rowToMessage(r))
  }

  /** 列出最近的根节点 sessions（branch_type = 'main'，无 parent） */
  listRecent(params: { source?: string; limit?: number } = {}): Session[] {
    const limit = params.limit ?? 20
    let sql: string
    let args: unknown[]

    if (params.source) {
      sql = `
        SELECT * FROM sessions
        WHERE parent_session_id IS NULL AND source = ?
        ORDER BY started_at DESC LIMIT ?
      `
      args = [params.source, limit]
    } else {
      sql = `
        SELECT * FROM sessions
        WHERE parent_session_id IS NULL
        ORDER BY started_at DESC LIMIT ?
      `
      args = [limit]
    }

    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[]
    return rows.map(r => this.rowToSession(r))
  }

  /** 读取 session 树（含子节点） */
  getTree(rootId: string): SessionTree | null {
    const session = this.get(rootId)
    if (!session) return null

    const childRows = this.db.prepare(`
      SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY started_at ASC
    `).all(rootId) as Record<string, unknown>[]

    const children = childRows.map(r => {
      const child = this.rowToSession(r)
      return this.getTree(child.id)!
    })

    return { session, children }
  }

  /** FTS5 全文搜索（跨所有 sessions） */
  search(query: string, limit = 20): SearchResult[] {
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
    `).all(query, limit) as Record<string, unknown>[]

    return rows.map(r => ({
      messageId: r['message_id'] as number,
      sessionId: r['session_id'] as string,
      role: r['role'] as string,
      content: r['content'] as string,
      createdAt: r['created_at'] as number,
      rank: r['rank'] as number,
    }))
  }

  /** 更新 session 标题 */
  setTitle(sessionId: string, title: string): void {
    this.db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, sessionId)
  }

  // -------------------------------------------------------------------------
  // 私有辅助
  // -------------------------------------------------------------------------

  private rowToSession(row: Record<string, unknown>): Session {
    return {
      id: row['id'] as string,
      parentSessionId: row['parent_session_id'] as string | null,
      branchType: row['branch_type'] as Session['branchType'],
      branchSummary: row['branch_summary'] as string | null,
      source: row['source'] as string,
      model: row['model'] as string | null,
      startedAt: row['started_at'] as number,
      endedAt: row['ended_at'] as number | null,
      endReason: row['end_reason'] as string | null,
      messageCount: row['message_count'] as number,
      inputTokens: row['input_tokens'] as number,
      outputTokens: row['output_tokens'] as number,
      title: row['title'] as string | null,
    }
  }

  private rowToMessage(row: Record<string, unknown>): StoredMessage {
    return {
      id: row['id'] as number,
      sessionId: row['session_id'] as string,
      role: row['role'] as StoredMessage['role'],
      content: row['content'] as string | null,
      toolCalls: row['tool_calls'] as string | null,
      toolCallId: row['tool_call_id'] as string | null,
      createdAt: row['created_at'] as number,
    }
  }
}
