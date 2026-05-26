// @ts-nocheck
import { randomUUID } from 'crypto';
import { agentRegistry } from './registry.js';
import { messageBus } from './bus.js';
const NAME_POOL = ['小张', '小王', '小李', '小赵', '小陈', '小刘', '小孙', '小周'];
export class AgentPool {
    config;
    nameIndex = 0;
    queue = [];
    alwaysOnIds = new Set();
    constructor(config = {}) {
        this.config = {
            maxTotal: config.maxTotal ?? 8,
            miscQuota: config.miscQuota ?? 2,
            alwaysOnMisc: config.alwaysOnMisc ?? 1,
            idleTimeoutMs: config.idleTimeoutMs ?? 300000,
        };
    }
    nextName() {
        const name = NAME_POOL[this.nameIndex % NAME_POOL.length];
        this.nameIndex++;
        return name;
    }
    total() { return agentRegistry.getAll().length; }
    countByType(type) {
        return agentRegistry.getAll().filter(a => a.type === type).length;
    }
    canSpawnMisc() {
        if (this.total() >= this.config.maxTotal)
            return false;
        const miscCount = this.countByType('misc');
        if (miscCount < this.config.miscQuota)
            return true;
        // Buffer: borrow from task quota if task has free slots
        return this.total() < this.config.maxTotal;
    }
    canSpawnTask() {
        return this.total() < this.config.maxTotal;
    }
    async spawnMisc(name) {
        if (!this.canSpawnMisc())
            return null;
        const miscCount = this.countByType('misc');
        const borrowed = miscCount >= this.config.miscQuota;
        const state = {
            id: randomUUID(),
            name: name ?? this.nextName(),
            type: 'misc',
            status: 'idle',
            sessionId: randomUUID(),
            borrowed,
            borrowedBy: borrowed ? 'task' : undefined,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
        };
        agentRegistry.register(state);
        messageBus.onMessage(state.id, async (msg) => this.handleMessage(state.id, msg));
        return state;
    }
    async spawnTask(taskId, taskTitle, name) {
        if (!this.canSpawnTask())
            return null;
        const state = {
            id: randomUUID(),
            name: name ?? this.nextName(),
            type: 'task',
            taskId,
            taskTitle,
            status: 'idle',
            sessionId: randomUUID(),
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
        };
        agentRegistry.register(state);
        messageBus.onMessage(state.id, async (msg) => this.handleMessage(state.id, msg));
        return state;
    }
    async handleMessage(agentId, msg) {
        const state = agentRegistry.get(agentId);
        if (!state)
            return;
        agentRegistry.update(agentId, { status: 'busy', currentWork: msg.originalUserMessage.slice(0, 50), lastActiveAt: Date.now() });
        try {
            // TODO M3: wire real AgentLoop here
            // For now: placeholder response with agent name prefix
            await msg.replyFn(`[${state.name}] 收到，正在处理...（AgentLoop 集成待 Phase M3）`);
        }
        finally {
            agentRegistry.update(agentId, { status: 'idle', currentWork: undefined, lastActiveAt: Date.now() });
            this.processQueue();
        }
    }
    enqueue(msg) {
        this.queue.push({ ...msg, id: randomUUID(), queuedAt: Date.now() });
    }
    processQueue() {
        if (this.queue.length === 0)
            return;
        const available = agentRegistry.getAvailableMisc();
        if (!available)
            return;
        const next = this.queue.shift();
        if (!next)
            return;
        messageBus.route(available.id, {
            id: next.id,
            originalUserMessage: next.userMessage,
            routeChain: [],
            sessionId: next.sessionId,
            replyFn: next.replyFn,
        });
    }
    async initialize() {
        for (let i = 0; i < this.config.alwaysOnMisc; i++) {
            const agent = await this.spawnMisc();
            if (agent)
                this.alwaysOnIds.add(agent.id);
        }
        console.log(`[AgentPool] initialized: ${this.config.alwaysOnMisc} always-on misc agent(s)`);
    }
    destroy(agentId) {
        if (this.alwaysOnIds.has(agentId))
            return; // 不销毁常驻 agent
        messageBus.offMessage(agentId);
        agentRegistry.unregister(agentId);
    }
    isAlwaysOn(agentId) {
        return this.alwaysOnIds.has(agentId);
    }
}
export const agentPool = new AgentPool();
