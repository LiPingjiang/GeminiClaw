import type { Message } from "../../providers/types.js"
import type { MemoryStrategy, ConversationContext } from "../strategy.js"

interface BufferStrategyConfig {
  recentMessageLimit: number
}

export class BufferStrategy implements MemoryStrategy {
  readonly name = "buffer"
  private sessions: Map<string, Message[]> = new Map()
  private limit: number

  constructor(config: BufferStrategyConfig) {
    this.limit = config.recentMessageLimit
  }

  async ensureSession(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, [])
    }
  }

  async getContext(sessionId: string, _userMessage: string): Promise<ConversationContext> {
    const all = this.sessions.get(sessionId) ?? []
    const messages = all.slice(-this.limit)
    return { messages, strategyName: this.name }
  }

  async appendTurn(sessionId: string, userMsg: Message, assistantMsg: Message): Promise<void> {
    await this.ensureSession(sessionId)
    const existing = this.sessions.get(sessionId)!
    existing.push(userMsg, assistantMsg)
  }

  async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this.ensureSession(sessionId)
    const existing = this.sessions.get(sessionId)!
    existing.push(...messages)
  }
}
