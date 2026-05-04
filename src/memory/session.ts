import { randomUUID } from "crypto"
import type { Message } from "../providers/types.js"

export class SessionMemory {
  private sessions: Map<string, Message[]> = new Map()

  get(sessionId: string): Message[] {
    return this.sessions.get(sessionId) ?? []
  }

  append(sessionId: string, message: Message): void {
    const existing = this.sessions.get(sessionId) ?? []
    this.sessions.set(sessionId, [...existing, message])
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  generateId(): string {
    return randomUUID()
  }
}
