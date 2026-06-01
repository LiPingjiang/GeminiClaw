// @ts-nocheck
import { randomUUID } from 'crypto';
import { agentRegistry } from './registry.js';
import { agentPool } from './pool.js';
import { messageBus } from './bus.js';
/** 简单 FTS 匹配：检查 userMessage 是否含有 task 关键词 */
function findMatchingTaskAgent(userMessage) {
    const lower = userMessage.toLowerCase();
    const taskAgents = agentRegistry.getAll().filter(a => a.type === 'task' && a.status !== 'busy' && a.taskTitle);
    for (const agent of taskAgents) {
        const keywords = agent.taskTitle.toLowerCase().split(/[\s\-_\/]+/).filter(k => k.length > 1);
        if (keywords.some(kw => lower.includes(kw)))
            return agent.id;
    }
    return undefined;
}
export async function dispatchMessage(params) {
    const { userMessage, sessionId, replyFn, stickyAgentName } = params;
    const buildMsg = () => ({
        id: randomUUID(),
        originalUserMessage: userMessage,
        routeChain: [],
        sessionId,
        replyFn,
    });
    // 0. Sticky agent preference
    if (stickyAgentName) {
        const sticky = agentRegistry.getByName(stickyAgentName);
        if (sticky && sticky.status === 'idle') {
            messageBus.route(sticky.id, buildMsg());
            return;
        }
        if (sticky && sticky.status === 'busy') {
            await replyFn(`[${stickyAgentName}] 正在处理其他任务，已转交其他 Agent`);
        }
    }
    // 1. Task agent FTS match
    const taskAgentId = findMatchingTaskAgent(userMessage);
    if (taskAgentId) {
        messageBus.route(taskAgentId, buildMsg());
        return;
    }
    // 2. Available misc agent
    const misc = agentRegistry.getAvailableMisc();
    if (misc) {
        messageBus.route(misc.id, buildMsg());
        return;
    }
    // 3. Spawn new misc if quota allows
    const spawned = await agentPool.spawnMisc();
    if (spawned) {
        messageBus.route(spawned.id, buildMsg());
        return;
    }
    // 4. All full: queue + notify
    agentPool.enqueue({ userMessage, replyFn, sessionId });
    await replyFn('[系统] 所有 Agent 正忙，消息已加入队列，稍后处理');
}
