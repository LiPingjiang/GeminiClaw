// src/evolution/trace/collector.ts
// TraceCollector: records conversation events into the evolution DB.
// Called by the chat route after each response; runs asynchronously so it
// never blocks the HTTP response.

import { randomUUID } from "crypto"
import type { EvolutionDB } from "../db.js"

export interface RecordParams {
  sessionId: string
  toolSequence: string[]   // list of tool names called during the conversation
  hadFailure: boolean      // true if any tool call failed or a 5xx occurred
  messageCount: number     // number of messages in this exchange
}

export class TraceCollector {
  private db: EvolutionDB

  constructor(db: EvolutionDB) {
    this.db = db
  }

  /**
   * Record a single conversation turn.
   * Designed to be called with setImmediate() from the chat route so it does
   * not add latency to the HTTP response.
   */
  record(params: RecordParams): void {
    const { sessionId, toolSequence, hadFailure, messageCount } = params
    try {
      this.db.insertTrace({
        id: randomUUID(),
        sessionId,
        toolSequence,
        hadFailure,
        messageCount,
        recordedAt: Date.now(),
      })
    } catch (err) {
      // Swallow errors — trace collection must never crash the main process
      console.error("[TraceCollector] Failed to record trace:", err)
    }
  }

  /**
   * Returns the failure rate (0–1) over the given time window.
   * Useful for CircuitBreaker and health checks.
   */
  getRecentFailureRate(windowMs: number): number {
    return this.db.getFailureRate(windowMs)
  }
}
