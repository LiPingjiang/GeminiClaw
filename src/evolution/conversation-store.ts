// src/evolution/conversation-store.ts
// Stores per-turn conversation content (userMessage + agentReply) for use
// by PreviewService when generating before/after comparisons.

import { randomUUID } from "crypto"
import type { EvolutionDB } from "./db.js"
import type { ConversationSample } from "./types.js"

export interface SaveParams {
  sessionId: string
  traceId?: string
  userMessage: string
  agentReply: string
  toolSequence?: string[]
  hadFailure?: boolean
}

export class ConversationStore {
  private db: EvolutionDB

  constructor(db: EvolutionDB) {
    this.db = db
  }

  /**
   * Save a conversation turn. Called by the chat route after each response.
   * Designed to be called with setImmediate() — must never throw.
   */
  save(params: SaveParams): void {
    try {
      const sample: ConversationSample = {
        id: randomUUID(),
        sessionId: params.sessionId,
        traceId: params.traceId,
        userMessage: params.userMessage,
        agentReply: params.agentReply,
        toolSequence: params.toolSequence ?? [],
        hadFailure: params.hadFailure ?? false,
        recordedAt: Date.now(),
      }
      this.db.insertConversationSample(sample)
    } catch (err) {
      // Swallow errors — must never crash the main process
      console.error("[ConversationStore] Failed to save sample:", err)
    }
  }
}
