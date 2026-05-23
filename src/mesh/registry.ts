import { AgentState, AgentType } from './types.js'

class AgentRegistry {
  private agents: Map<string, AgentState> = new Map()

  register(agent: AgentState): void {
    this.agents.set(agent.id, agent)
  }

  unregister(agentId: string): void {
    this.agents.delete(agentId)
  }

  get(agentId: string): AgentState | undefined {
    return this.agents.get(agentId)
  }

  getAll(): AgentState[] {
    return Array.from(this.agents.values())
  }

  // 按 taskId 查找 task agent
  getByTaskId(taskId: string): AgentState | undefined {
    for (const agent of this.agents.values()) {
      if (agent.taskId === taskId) return agent
    }
    return undefined
  }

  // 查找可用的 misc agent（status=idle，type=misc）
  getAvailableMisc(): AgentState | undefined {
    for (const agent of this.agents.values()) {
      if (agent.type === 'misc' && agent.status === 'idle') return agent
    }
    return undefined
  }

  // 计数
  countByType(type: AgentType): number {
    let count = 0
    for (const agent of this.agents.values()) {
      if (agent.type === type) count++
    }
    return count
  }

  countBusy(): number {
    let count = 0
    for (const agent of this.agents.values()) {
      if (agent.status === 'busy') count++
    }
    return count
  }

  // 更新 agent 状态（partial update）
  update(agentId: string, patch: Partial<AgentState>): void {
    const existing = this.agents.get(agentId)
    if (existing) {
      this.agents.set(agentId, { ...existing, ...patch })
    }
  }

  // 生成给其他 Agent 看的快照文本
  getSnapshot(): string {
    const all = this.getAll()
    if (all.length === 0) {
      return 'Active agents (0): (none)'
    }
    const lines = all.map(agent => {
      const statusPart = agent.status
      if (agent.type === 'task') {
        const taskPart = agent.taskTitle ? `Task: ${agent.taskTitle}` : `Task: ${agent.taskId ?? 'unknown'}`
        const workPart = agent.currentWork ? ` | "${agent.currentWork}"` : ''
        return `- [task] ${agent.id} ${statusPart} | ${taskPart}${workPart}`
      }
      return `- [misc] ${agent.id} ${statusPart}`
    })
    return `Active agents (${all.length}):\n${lines.join('\n')}`
  }
}

// 导出单例
export const agentRegistry = new AgentRegistry()
