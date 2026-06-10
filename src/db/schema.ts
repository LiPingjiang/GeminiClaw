import type { Db } from "./client.js"
export { openDb } from "./client.js"

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id            TEXT PRIMARY KEY,
      title         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      message_count INTEGER NOT NULL DEFAULT 0,
      topic_ids     TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_session
      ON chat_messages(session_id, id);

    CREATE TABLE IF NOT EXISTS memory_topics (
      id               TEXT PRIMARY KEY,
      title            TEXT NOT NULL,
      summary          TEXT,
      doc_level2       TEXT,
      doc_level3       TEXT,
      doc_size         INTEGER NOT NULL DEFAULT 0,
      active           INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
      access_count     INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_memory_topics_active
      ON memory_topics(active, last_accessed_at);

    -- User-Agent relationship: tracks all agents a user has created
    CREATE TABLE IF NOT EXISTS user_agents (
      openid      TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      agent_name  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (openid, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_agents_openid
      ON user_agents(openid);
  `)
}
