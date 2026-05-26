// @ts-nocheck
// src/tools/list_sessions.ts
import { registry } from './registry.js';
registry.register({
    name: 'list_sessions',
    description: '列出所有可用的对话 session 列表（按最近活跃排序），用于跨 session 读取其他 Agent 的工作历史。返回 session_id、消息数、时间范围。',
    schema: {
        type: 'object',
        properties: {
            limit: { type: 'number', description: '返回最近 N 个 session，默认 20' }
        },
        required: []
    },
    handler: async (args, ctx) => {
        const db = ctx.extra?.db;
        if (!db)
            return { type: 'error', error: 'list_sessions: db not available' };
        const limit = args.limit ?? 20;
        try {
            const sessions = db.prepare(`
        SELECT
          cm.session_id,
          a.agent_name,
          a.description,
          MIN(cm.created_at) as first_msg,
          MAX(cm.created_at) as last_msg,
          COUNT(*) as msg_count
        FROM chat_messages cm
        LEFT JOIN agents a ON a.session_id = cm.session_id
        GROUP BY cm.session_id
        ORDER BY last_msg DESC
        LIMIT ?
      `).all(limit);
            return { type: 'text', text: JSON.stringify(sessions, null, 2) };
        }
        catch (err) {
            // agents 表可能不存在，降级
            const sessions = db.prepare(`
        SELECT session_id, MIN(created_at) as first_msg, MAX(created_at) as last_msg, COUNT(*) as msg_count
        FROM chat_messages
        GROUP BY session_id
        ORDER BY last_msg DESC
        LIMIT ?
      `).all(limit);
            return { type: 'text', text: JSON.stringify(sessions, null, 2) };
        }
    }
});
