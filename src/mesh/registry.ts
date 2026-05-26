// @ts-nocheck
class AgentRegistry {
    agents = new Map();
    register(agent) {
        this.agents.set(agent.id, agent);
    }
    unregister(agentId) {
        this.agents.delete(agentId);
    }
    get(agentId) {
        return this.agents.get(agentId);
    }
    getAll() {
        return Array.from(this.agents.values());
    }
    // 按名字查找 agent（sticky 用）
    getByName(name) {
        for (const agent of this.agents.values()) {
            if (agent.name === name)
                return agent;
        }
        return undefined;
    }
    // 按 taskId 查找 task agent
    getByTaskId(taskId) {
        for (const agent of this.agents.values()) {
            if (agent.taskId === taskId)
                return agent;
        }
        return undefined;
    }
    // 查找可用的 misc agent（status=idle，type=misc）
    getAvailableMisc() {
        for (const agent of this.agents.values()) {
            if (agent.type === 'misc' && agent.status === 'idle')
                return agent;
        }
        return undefined;
    }
    // 计数
    countByType(type) {
        let count = 0;
        for (const agent of this.agents.values()) {
            if (agent.type === type)
                count++;
        }
        return count;
    }
    countBusy() {
        let count = 0;
        for (const agent of this.agents.values()) {
            if (agent.status === 'busy')
                count++;
        }
        return count;
    }
    // 更新 agent 状态（partial update）
    update(agentId, patch) {
        const existing = this.agents.get(agentId);
        if (existing) {
            this.agents.set(agentId, { ...existing, ...patch });
        }
    }
    // 生成给其他 Agent 看的快照文本
    getSnapshot() {
        const all = this.getAll();
        if (all.length === 0) {
            return 'Active agents (0): (none)';
        }
        const lines = all.map(agent => {
            const statusPart = agent.status;
            if (agent.type === 'task') {
                const taskPart = agent.taskTitle ? `Task: ${agent.taskTitle}` : `Task: ${agent.taskId ?? 'unknown'}`;
                const workPart = agent.currentWork ? ` | "${agent.currentWork}"` : '';
                return `- [task] ${agent.id} (${agent.name}) ${statusPart} | ${taskPart}${workPart}`;
            }
            return `- [misc] ${agent.id} (${agent.name}) ${statusPart}`;
        });
        return `Active agents (${all.length}):\n${lines.join('\n')}`;
    }
}
// 导出单例
export const agentRegistry = new AgentRegistry();
