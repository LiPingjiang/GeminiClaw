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
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role          TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content       TEXT NOT NULL,
      tool_calls    TEXT,
      tool_call_id  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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

    CREATE TABLE IF NOT EXISTS user_sessions (
      openid      TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      agent_name  TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    );

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

  // Add tool_calls and tool_call_id columns if they don't exist yet
  try {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN tool_calls TEXT;`)
  } catch {
    // Column already exists — ignore
  }
  try {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN tool_call_id TEXT;`)
  } catch {
    // Column already exists — ignore
  }

  // Widen role CHECK to include 'tool'.
  // SQLite doesn't support ALTER COLUMN, so we use the recreate pattern.
  // First, try a dry-run INSERT; if the existing CHECK rejects 'tool', recreate.
  let needsRoleWiden = false
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS __role_check_tmp (role TEXT CHECK(role IN ('user','assistant','system','tool')));
      DROP TABLE __role_check_tmp;
    `)
    // Check if current table accepts 'tool' by inspecting its SQL
    const tblInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_messages'`).get() as { sql: string } | undefined
    if (tblInfo && !tblInfo.sql.includes("'tool'")) {
      needsRoleWiden = true
    }
  } catch {
    // ignore
  }

  if (needsRoleWiden) {
    db.pragma('foreign_keys = OFF')
    db.exec(`
      CREATE TABLE chat_messages_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role          TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
        content       TEXT NOT NULL,
        tool_calls    TEXT,
        tool_call_id  TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO chat_messages_new (id, session_id, role, content, tool_calls, tool_call_id, created_at)
        SELECT id, session_id, role, content, tool_calls, tool_call_id, created_at FROM chat_messages;
      DROP TABLE chat_messages;
      ALTER TABLE chat_messages_new RENAME TO chat_messages;
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);
    `)
    db.pragma('foreign_keys = ON')
    console.log('[schema] Migrated chat_messages: widened role CHECK to include tool')
  }
}
