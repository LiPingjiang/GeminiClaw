import { agentRegistry } from './registry.js'

export function getMeshStatus() {
  const agents = agentRegistry.getAll()
  return {
    totalAgents: agents.length,
    agents: agents.map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      status: a.status,
      taskId: a.taskId,
      taskTitle: a.taskTitle,
      currentWork: a.currentWork,
      borrowed: a.borrowed ?? false,
    })),
    snapshot: agentRegistry.getSnapshot(),
  }
}
