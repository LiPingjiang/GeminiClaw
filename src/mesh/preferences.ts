// @ts-nocheck
export class PreferencesStore {
    db;
    constructor(db) {
        this.db = db;
    }
    get(userId) {
        const row = this.db.prepare('SELECT sticky_agent_name FROM user_preferences WHERE user_id = ?').get(userId);
        return { stickyAgentName: row?.sticky_agent_name ?? undefined };
    }
    setStickyAgent(userId, agentName) {
        this.db.prepare(`
      INSERT INTO user_preferences (user_id, sticky_agent_name, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET sticky_agent_name = excluded.sticky_agent_name, updated_at = excluded.updated_at
    `).run(userId, agentName, Date.now());
    }
}
