// @ts-nocheck
// src/tools/create_agent.ts
// Tool: create a new named agent and transfer the current user's sticky session to it.
import { registry } from './registry.js';
import { createSessionWithAgent } from '../server/routes/agents.js';
import { AgentRepository } from '../agents/repository.js';
registry.register({
    name: 'create_agent',
    description: '创建一个专门负责特定任务的新 Agent，并将当前用户的对话自动切换过去。' +
        '当收到的任务超出自己的职责范围，或需要专门的 Agent 来处理时调用此工具。',
    schema: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Agent 名称，简短有意义，如"财经助手"、"代码助手"、"Claw 专家"',
            },
            description: {
                type: 'string',
                description: '这个 Agent 的职责描述，用于后续路由匹配',
            },
            template: {
                type: 'string',
                description: '使用的模板名称，默认 "base"',
            },
        },
        required: ['name', 'description'],
    },
    handler: async (params, ctx) => {
        const db = ctx.extra?.db;
        const userId = ctx.extra?.userId;
        if (!db) {
            return { type: 'error', error: 'create_agent: db not available in tool context' };
        }
        const name = params['name'];
        const description = params['description'];
        const template = params['template'] ?? 'base';
        try {
            // ── Dedup: check if an active agent with same name already exists ──
            const agentRepo = new AgentRepository(db);
            const existingByName = agentRepo.findActiveByName(name);
            if (existingByName) {
                // Reuse existing agent instead of creating duplicate
                if (userId) {
                    db.prepare(`INSERT INTO user_sessions (openid, session_id, agent_id, agent_name, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(openid) DO UPDATE SET
             session_id = excluded.session_id,
             agent_id   = excluded.agent_id,
             agent_name = excluded.agent_name,
             updated_at = excluded.updated_at`).run(userId, existingByName.session_id, existingByName.id, existingByName.agent_name, Date.now());
                }
                ctx.logger.info(`[create_agent] reused existing agent "${name}" (${existingByName.id})`);
                return {
                    type: text,
                    text: `已有同名助手 **${name}**，已切换到该助手。`,
                };
            }
            // Create new agent session
            const { sessionId, agentId } = await createSessionWithAgent(template, db);
            // Update agent name and description
            agentRepo.update(agentId, { agent_name: name, description });
            // Update sticky: route this user's next message to the new agent
            if (userId) {
                db.prepare(`INSERT INTO user_sessions (openid, session_id, agent_id, agent_name, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(openid) DO UPDATE SET
             session_id = excluded.session_id,
             agent_id   = excluded.agent_id,
             agent_name = excluded.agent_name,
             updated_at = excluded.updated_at`).run(userId, sessionId, agentId, name, Date.now());
            }
            ctx.logger.info(`[create_agent] created agent "${name}" (${agentId}), sticky updated for user ${userId}`);
            return {
                type: 'text',
                text: `已创建 **${name}**（职责：${description}）。下一条消息将由 ${name} 接手处理。`,
            };
        }
        catch (err) {
            return { type: 'error', error: `create_agent failed: ${err.message}` };
        }
    },
});
