import type { Db } from '../db/client.js'

export interface UserPreferences {
  stickyAgentName?: string
}

export class PreferencesStore {
  constructor(private db: Db) {}

  get(userId: string): UserPreferences {
    const row = this.db.prepare(
      'SELECT sticky_agent_name FROM user_preferences WHERE user_id = ?'
    ).get(userId) as { sticky_agent_name: string | null } | undefined
    return { stickyAgentName: row?.sticky_agent_name ?? undefined }
  }

  setStickyAgent(userId: string, agentName: string | null): void {
    this.db.prepare(`
      INSERT INTO user_preferences (user_id, sticky_agent_name, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET sticky_agent_name = excluded.sticky_agent_name, updated_at = excluded.updated_at
    `).run(userId, agentName, Date.now())
  }
}
