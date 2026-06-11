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

    -- Renamed from memory_topics → public_knowledge (shared knowledge base across all agents)
    CREATE TABLE IF NOT EXISTS public_knowledge (
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

    CREATE INDEX IF NOT EXISTS idx_public_knowledge_active
      ON public_knowledge(active, last_accessed_at);

    -- Backward-compat alias: any legacy SQL referencing memory_topics still works
    CREATE VIEW IF NOT EXISTS memory_topics AS SELECT * FROM public_knowledge;

    -- Agent registry: one row per agent instance
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

    CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);
    CREATE INDEX IF NOT EXISTS idx_agents_parent  ON agents(parent_agent_id);

    -- Per-user sticky session state (which agent is active for this user)
    CREATE TABLE IF NOT EXISTS user_sessions (
      openid      TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      agent_name  TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    -- Per-agent private memory metadata index.
    -- Tracks which agents have private memory files and their cold-start state.
    -- Actual content lives on disk at paths resolved by MemoryPaths.
    CREATE TABLE IF NOT EXISTS agent_memory (
      agent_id         TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      has_agent_md     INTEGER NOT NULL DEFAULT 0,
      has_memory_md    INTEGER NOT NULL DEFAULT 0,
      has_daily        INTEGER NOT NULL DEFAULT 0,
      cold_start_done  INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

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
