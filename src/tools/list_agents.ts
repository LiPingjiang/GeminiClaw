// @ts-nocheck
// src/tools/list_agents.ts
// Tool: list, archive, unarchive, and search agents.
import { registry } from './registry.js';
import { AgentRepository } from '../agents/repository.js';

registry.register({
  name: 'list_agents',
  description: '列出、存档、恢复或搜索助手（Agent）。默认只显示活跃的 Agent。' +
    '用户问"有哪些助手"、"助手列表"时调用。' +
    '用户说"存档/关闭/隐藏某个agent"时用 action=archive。' +
    '用户说"恢复/激活某个agent"时用 action=unarchive。' +
    '用户说"搜索已存档的agent"时用 action=search_archived。',
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'archive', 'unarchive', 'search_archived'],
        description: '操作类型。list=列出活跃agent, archive=存档, unarchive=恢复, search_archived=搜索已存档',
      },
      agent_id: {
        type: 'string',
        description: '要存档或恢复的 agent ID（archive/unarchive 时必填）',
      },
      keyword: {
        type: 'string',
        description: '搜索关键词（search_archived 时可选）',
      },
    },
    required: [],
  },
  handler: async (params: Record<string, unknown>, ctx: any) => {
    const db = ctx.extra?.db;
    if (!db) {
      return { type: 'error', error: 'list_agents: db not available' };
    }

    const agentRepo = new AgentRepository(db);
    const action = (params['action'] as string) ?? 'list';
    const userId = ctx.extra?.userId;

    // ── Archive ──
    if (action === 'archive') {
      const agentId = params['agent_id'] as string;
      if (!agentId) {
        return { type: 'error', error: '请提供要存档的 agent_id' };
      }
      const agent = agentRepo.getById(agentId);
      if (!agent) {
        return { type: 'error', error: `未找到 agent: ${agentId}` };
      }
      agentRepo.archive(agentId);
      return {
        type: 'text',
        text: `已将 **${agent.agent_name}** 存档。它不会再出现在活跃列表中，但可以通过搜索找回并恢复。`,
      };
    }

    // ── Unarchive ──
    if (action === 'unarchive') {
      const agentId = params['agent_id'] as string;
      if (!agentId) {
        return { type: 'error', error: '请提供要恢复的 agent_id' };
      }
      const agent = agentRepo.getById(agentId);
      if (!agent) {
        return { type: 'error', error: `未找到 agent: ${agentId}` };
      }
      agentRepo.unarchive(agentId);
      return {
        type: 'text',
        text: `已恢复 **${agent.agent_name}**，它现在重新出现在活跃列表中。`,
      };
    }

    // ── Search archived ──
    if (action === 'search_archived') {
      const keyword = params['keyword'] as string | undefined;
      const archived = agentRepo.listArchived(keyword);
      if (archived.length === 0) {
        return { type: 'text', text: keyword ? `没有找到包含"${keyword}"的已存档助手。` : '没有已存档的助手。' };
      }
      const lines = archived.map((a: any, i: number) => {
        return `${i + 1}. **${a.agent_name}**（${a.description ?? '无描述'}）\n   ID: \`${a.id}\` | 存档于 ${a.updated_at}`;
      });
      return {
        type: 'text',
        text: `已存档的助手（共 ${archived.length} 个）：\n${lines.join('\n')}\n\n使用 action=unarchive + agent_id 可恢复。`,
      };
    }

    // ── List active (default) ──
    const agents = agentRepo.listActiveMainAgents();

    if (agents.length === 0) {
      return { type: 'text', text: '当前没有活跃的助手。' };
    }

    let currentAgentId: string | null = null;
    if (userId) {
      const sticky = db.prepare(
        `SELECT agent_id FROM user_sessions WHERE openid = ?`
      ).get(userId) as { agent_id: string } | undefined;
      currentAgentId = sticky?.agent_id ?? null;
    }

    const lines = agents.map((a: any, i: number) => {
      const isCurrent = a.id === currentAgentId ? ' ← 当前' : '';
      const desc = a.description ? `（${a.description}）` : '';
      const tpl = a.template_name ? ` [模板:${a.template_name}]` : '';
      return `${i + 1}. **${a.agent_name}**${desc}${tpl}${isCurrent}`;
    });

    return {
      type: 'text',
      text: `活跃助手（共 ${agents.length} 个）：\n${lines.join('\n')}\n\n• switch_agent 切换助手\n• list_agents action=archive agent_id=xxx 存档助手\n• list_agents action=search_archived 查看已存档`,
    };
  },
});
