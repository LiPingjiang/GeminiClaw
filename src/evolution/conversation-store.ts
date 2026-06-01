// @ts-nocheck
// src/evolution/conversation-store.ts
// Stores per-turn conversation content (userMessage + agentReply) for use
// by PreviewService when generating before/after comparisons.
import { randomUUID } from "crypto";
export class ConversationStore {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Save a conversation turn. Called by the chat route after each response.
     * Designed to be called with setImmediate() — must never throw.
     */
    save(params) {
        try {
            const sample = {
                id: randomUUID(),
                sessionId: params.sessionId,
                traceId: params.traceId,
                userMessage: params.userMessage,
                agentReply: params.agentReply,
                toolSequence: params.toolSequence ?? [],
                hadFailure: params.hadFailure ?? false,
                recordedAt: Date.now(),
            };
            this.db.insertConversationSample(sample);
        }
        catch (err) {
            // Swallow errors — must never crash the main process
            console.error("[ConversationStore] Failed to save sample:", err);
        }
    }
}
