// src/trace/hub.ts
import { EventEmitter } from 'events'
import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { AgentEvent } from '../agent/types.js'

export interface TraceEvent {
  ts: number
  sessionId: string
  requestId: string
  userId?: string        // optional — QQBot sets this
  agentEvent: Record<string, unknown>
}

function getTracePath(): string {
  const dir = join(homedir(), '.gemeniclaw', 'audit')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  return join(dir, `trace-${date}.jsonl`)
}

class TraceHub extends EventEmitter {
  private static _instance: TraceHub | null = null

  private constructor() {
    super()
    this.setMaxListeners(100)
  }

  static get instance(): TraceHub {
    if (!TraceHub._instance) TraceHub._instance = new TraceHub()
    return TraceHub._instance
  }

  private _persist(traceEvent: TraceEvent): void {
    try {
      appendFileSync(getTracePath(), JSON.stringify(traceEvent) + '\n')
    } catch { /* ignore write errors */ }
  }

  /**
   * Publish a trace event (convenience wrapper).
   * Use this from loop.ts and other producers.
   */
  publish(sessionId: string, requestId: string, agentEvent: AgentEvent, userId?: string): void {
    const traceEvent: TraceEvent = {
      ts: Date.now(),
      sessionId,
      requestId,
      ...(userId ? { userId } : {}),
      agentEvent: agentEvent as unknown as Record<string, unknown>,
    }
    this._persist(traceEvent)
    super.emit('trace', traceEvent)
  }

  /**
   * @deprecated Use publish() instead. Kept for QQBot backward compat.
   */
  publishLegacy(event: TraceEvent): void {
    this._persist(event)
    super.emit('trace', event)
  }

  subscribe(listener: (event: TraceEvent) => void): () => void {
    this.on('trace', listener)
    return () => this.off('trace', listener)
  }
}

export const traceHub = TraceHub.instance
