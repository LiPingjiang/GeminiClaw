export type AgentType = 'misc' | 'task'
export type AgentStatus = 'idle' | 'busy' | 'sleeping'

export interface AgentState {
  id: string
  name: string
  type: AgentType
  taskId?: string
  taskTitle?: string
  status: AgentStatus
  currentWork?: string      // 正在处理的内容摘要（1句话）
  sessionId: string
  borrowed?: boolean        // 是否借用自其他配额
  borrowedBy?: AgentType
  createdAt: number
  lastActiveAt: number
}

export interface RoutedMessage {
  id: string                // UUID，环路检测用
  originalUserMessage: string
  fromAgentId?: string      // 转发来源（undefined = Receptionist）
  routeChain: string[]      // 已经过的 agentId，防环
  sessionId: string
  replyFn: (text: string) => Promise<void>
}
