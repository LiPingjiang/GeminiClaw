// @ts-nocheck
// src/tools/switch_agent.ts
// Tool: switch the current user's sticky session to a different agent.
import { registry } from './registry.js';

registry.register({
  name: 'switch_agent',
  description: '切换到指定的助手（Agent）。可以通过名称或序号切换。用户说"切换到龙股Agent"、"换个助手"、"用XX助手"时调用。',
  schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '要切换到的助手名称（模糊匹配）',
      },
      index: {
        type: 'number',
        description: '要切换到的助手序号（从 list_agents 获取的编号）',
      },
    },
    required: [],
  },
  handler: async (params: Record<string, unknown>, ctx: any) => {
    const db = ctx.extra?.db;
    const userId = ctx.extra?.userId;
    if (!db) {
      return { type: 'error', error: 'switch_agent: db not available' };
    }
    if (!userId) {
      return { type: 'error', error: 'switch_agent: userId not available' };
    }

    const name = params['name'] as string | undefined;
    const index = params['index'] as number | undefined;

    // Get all active agents
    const agents = db.prepare(
      `SELECT id, agent_name, description, session_id
       FROM agents
       WHERE depth = 0 AND status = 'active'
       ORDER BY updated_at DESC`
    ).all() as Array<{
      id: string;
      agent_name: string;
      description: string | null;
      session_id: string;
    }>;

    if (agents.length === 0) {
      return { type: 'error', error: '没有可切换的助手。' };
    }

    let target: typeof agents[0] | undefined;

    if (index !== undefined) {
      // Switch by index (1-based)
      const idx = Math.round(index) - 1;
      if (idx < 0 || idx >= agents.length) {
        return { type: 'error', error: `序号 ${index} 无效，有效范围 1-${agents.length}` };
      }
      target = agents[idx];
    } else if (name) {
      // Switch by name (fuzzy match)
      const lower = name.toLowerCase();
      target = agents.find(a => a.agent_name.toLowerCase() === lower)
        ?? agents.find(a => a.agent_name.toLowerCase().includes(lower))
        ?? agents.find(a => (a.description ?? '').toLowerCase().includes(lower));
    }

    if (!target) {
      const available = agents.map((a, i) => `${i + 1}. ${a.agent_name}`).join('\n');
      return {
        type: 'error',
        error: `未找到匹配的助手。可用助手：\n${available}`,
      };
    }

    // Check if already on this agent
    const sticky = db.prepare(
      `SELECT agent_id FROM user_sessions WHERE openid = ?`
    ).get(userId) as { agent_id: string } | undefined;

    if (sticky?.agent_id === target.id) {
      return { type: 'text', text: `你已经在使用 **${target.agent_name}** 了。` };
    }

    // Switch sticky session
    db.prepare(
      `INSERT INTO user_sessions (openid, session_id, agent_id, agent_name, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(openid) DO UPDATE SET
         session_id = excluded.session_id,
         agent_id   = excluded.agent_id,
         agent_name = excluded.agent_name,
         updated_at = excluded.updated_at`
    ).run(userId, target.session_id, target.id, target.agent_name, Date.now());

    ctx.logger.info(`[switch_agent] user ${userId} switched to "${target.agent_name}" (${target.id})`);

    return {
      type: 'text',
      text: `已切换到 **${target.agent_name}**${target.description ? `（${target.description}）` : ''}。下一条消息将由该助手处理。`,
    };
  },
});
