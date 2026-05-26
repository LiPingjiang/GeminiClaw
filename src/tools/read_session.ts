// @ts-nocheck
// src/tools/read_session.ts
import { registry } from './registry.js';
registry.register({
    name: 'read_session',
    description: '读取指定 session 的历史消息，用于了解其他 Agent 的工作上下文、追溯问题排查过程、还原事件时间线。',
    schema: {
        type: 'object',
        properties: {
            session_id: { type: 'string', description: '目标 session_id（从 list_sessions 获取）' },
            limit: { type: 'number', description: '最近 N 条消息，默认 30，最大 100' },
            role_filter: { type: 'string', description: '只看某种角色消息：user / assistant / tool，不填则全部返回' }
        },
        required: ['session_id']
    },
    handler: async (args, ctx) => {
        const db = ctx.extra?.db;
        if (!db)
            return { type: 'error', error: 'read_session: db not available' };
        const limit = Math.min(args.limit ?? 30, 100);
        const roleFilter = args.role_filter;
        try {
            const sql = roleFilter
                ? `SELECT role, substr(content,1,800) as content, created_at, tool_call_id FROM chat_messages WHERE session_id = ? AND role = ? ORDER BY created_at ASC LIMIT ?`
                : `SELECT role, substr(content,1,800) as content, created_at, tool_call_id FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`;
            const rows = roleFilter
                ? db.prepare(sql).all(args.session_id, roleFilter, limit)
                : db.prepare(sql).all(args.session_id, limit);
            if (rows.length === 0) {
                return { type: 'text', text: `session ${args.session_id} 不存在或无消息记录` };
            }
            return { type: 'text', text: JSON.stringify(rows, null, 2) };
        }
        catch (err) {
            return { type: 'error', error: `read_session failed: ${err.message}` };
        }
    }
});
