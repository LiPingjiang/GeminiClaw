import { randomUUID } from 'crypto'
import { AgentState, AgentType, RoutedMessage } from './types.js'
import { agentRegistry } from './registry.js'
import { messageBus } from './bus.js'

const NAME_POOL = ['小张', '小王', '小李', '小赵', '小陈', '小刘', '小孙', '小周']

interface PoolConfig {
  maxTotal: number        // 默认 8
  miscQuota: number       // 默认 2
  alwaysOnMisc: number    // 默认 1
  idleTimeoutMs: number   // 默认 300000
}

interface QueuedMessage {
  id: string
  userMessage: string
  sessionId: string
  replyFn: (text: string) => Promise<void>
  queuedAt: number
}

export class AgentPool {
  private config: PoolConfig
  private nameIndex = 0
  private queue: QueuedMessage[] = []
  private alwaysOnIds: Set<string> = new Set()

  constructor(config: Partial<PoolConfig> = {}) {
    this.config = {
      maxTotal: config.maxTotal ?? 8,
      miscQuota: config.miscQuota ?? 2,
      alwaysOnMisc: config.alwaysOnMisc ?? 1,
      idleTimeoutMs: config.idleTimeoutMs ?? 300000,
    }
  }

  private nextName(): string {
    const name = NAME_POOL[this.nameIndex % NAME_POOL.length]
    this.nameIndex++
    return name
  }

  private total() { return agentRegistry.getAll().length }
  private countByType(type: AgentType) {
    return agentRegistry.getAll().filter(a => a.type === type).length
  }

  canSpawnMisc(): boolean {
    if (this.total() >= this.config.maxTotal) return false
    const miscCount = this.countByType('misc')
    if (miscCount < this.config.miscQuota) return true
    // Buffer: borrow from task quota if task has free slots
    return this.total() < this.config.maxTotal
  }

  canSpawnTask(): boolean {
    return this.total() < this.config.maxTotal
  }

  async spawnMisc(name?: string): Promise<AgentState | null> {
    if (!this.canSpawnMisc()) return null
    const miscCount = this.countByType('misc')
    const borrowed = miscCount >= this.config.miscQuota
    const state: AgentState = {
      id: randomUUID(),
      name: name ?? this.nextName(),
      type: 'misc',
      status: 'idle',
      sessionId: randomUUID(),
      borrowed,
      borrowedBy: borrowed ? 'task' as AgentType : undefined,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    }
    agentRegistry.register(state)
    messageBus.onMessage(state.id, async (msg) => this.handleMessage(state.id, msg))
    return state
  }

  async spawnTask(taskId: string, taskTitle: string, name?: string): Promise<AgentState | null> {
    if (!this.canSpawnTask()) return null
    const state: AgentState = {
      id: randomUUID(),
      name: name ?? this.nextName(),
      type: 'task',
      taskId,
      taskTitle,
      status: 'idle',
      sessionId: randomUUID(),
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    }
    agentRegistry.register(state)
    messageBus.onMessage(state.id, async (msg) => this.handleMessage(state.id, msg))
    return state
  }

  private async handleMessage(agentId: string, msg: RoutedMessage): Promise<void> {
    const state = agentRegistry.get(agentId)
    if (!state) return
    agentRegistry.update(agentId, { status: 'busy', currentWork: msg.originalUserMessage.slice(0, 50), lastActiveAt: Date.now() })
    try {
      // TODO M3: wire real AgentLoop here
      // For now: placeholder response with agent name prefix
      await msg.replyFn(`[${state.name}] 收到，正在处理...（AgentLoop 集成待 Phase M3）`)
    } finally {
      agentRegistry.update(agentId, { status: 'idle', currentWork: undefined, lastActiveAt: Date.now() })
      this.processQueue()
    }
  }

  enqueue(msg: Omit<QueuedMessage, 'id' | 'queuedAt'>): void {
    this.queue.push({ ...msg, id: randomUUID(), queuedAt: Date.now() })
  }

  private processQueue(): void {
    if (this.queue.length === 0) return
    const available = agentRegistry.getAvailableMisc()
    if (!available) return
    const next = this.queue.shift()
    if (!next) return
    messageBus.route(available.id, {
      id: next.id,
      originalUserMessage: next.userMessage,
      routeChain: [],
      sessionId: next.sessionId,
      replyFn: next.replyFn,
    })
  }

  async initialize(): Promise<void> {
    for (let i = 0; i < this.config.alwaysOnMisc; i++) {
      const agent = await this.spawnMisc()
      if (agent) this.alwaysOnIds.add(agent.id)
    }
    console.log(`[AgentPool] initialized: ${this.config.alwaysOnMisc} always-on misc agent(s)`)
  }

  destroy(agentId: string): void {
    if (this.alwaysOnIds.has(agentId)) return // 不销毁常驻 agent
    messageBus.offMessage(agentId)
    agentRegistry.unregister(agentId)
  }

  isAlwaysOn(agentId: string): boolean {
    return this.alwaysOnIds.has(agentId)
  }
}

export const agentPool = new AgentPool()
