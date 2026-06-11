// @ts-nocheck
// src/tools/list_agents.ts
// Tool: list all available agents for the current user.
import { registry } from './registry.js';

registry.register({
  name: 'list_agents',
  description: '列出当前用户可用的所有助手（Agent），包含名称、职责、状态（忙/闲）。用户问"有哪些助手"、"助手列表"、"哪些agent"时调用。',
  schema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async (_params: Record<string, unknown>, ctx: any) => {
    const db = ctx.extra?.db;
    if (!db) {
      return { type: 'error', error: 'list_agents: db not available' };
    }

    // List all active agents (depth=0 are main agents)
    const agents = db.prepare(
      `SELECT id, agent_name, description, status, updated_at
       FROM agents
       WHERE depth = 0 AND status = 'active'
       ORDER BY updated_at DESC`
    ).all() as Array<{
      id: string;
      agent_name: string;
      description: string | null;
      status: string;
      updated_at: string;
    }>;

    if (agents.length === 0) {
      return { type: 'text', text: '当前没有活跃的助手。' };
    }

    // Check which one is the current user's sticky agent
    const userId = ctx.extra?.userId;
    let currentAgentId: string | null = null;
    if (userId) {
      const sticky = db.prepare(
        `SELECT agent_id FROM user_sessions WHERE openid = ?`
      ).get(userId) as { agent_id: string } | undefined;
      currentAgentId = sticky?.agent_id ?? null;
    }

    const lines = agents.map((a, i) => {
      const isCurrent = a.id === currentAgentId ? ' ← 当前' : '';
      const desc = a.description ? `（${a.description}）` : '';
      return `${i + 1}. **${a.agent_name}**${desc}${isCurrent}`;
    });

    return {
      type: 'text',
      text: `共 ${agents.length} 个助手：\n${lines.join('\n')}\n\n使用 switch_agent 工具可切换到指定助手。`,
    };
  },
});
