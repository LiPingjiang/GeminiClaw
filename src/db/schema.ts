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

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY,
      sticky_agent_name TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL REFERENCES chat_sessions(id),
      parent_agent_id TEXT REFERENCES agents(id),
      template_name   TEXT NOT NULL,
      agent_name      TEXT NOT NULL,
      description     TEXT,
      depth           INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL REFERENCES agents(id),
      session_id  TEXT NOT NULL REFERENCES chat_sessions(id),
      parent_id   TEXT REFERENCES tasks(id),
      title       TEXT NOT NULL,
      description TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      depth       INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);
    CREATE INDEX IF NOT EXISTS idx_agents_parent  ON agents(parent_agent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_agent    ON tasks(agent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent   ON tasks(parent_id);
  `)

  // ALTER TABLE statements that may fail if column already exists
  try {
    db.exec(`ALTER TABLE chat_sessions ADD COLUMN main_agent_id TEXT;`)
  } catch {
    // Column already exists — ignore
  }
}
