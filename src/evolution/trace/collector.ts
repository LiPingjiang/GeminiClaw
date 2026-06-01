// @ts-nocheck
// src/evolution/trace/collector.ts
// TraceCollector: records conversation events into the evolution DB.
// Called by the chat route after each response; runs asynchronously so it
// never blocks the HTTP response.
import { randomUUID } from "crypto";
export class TraceCollector {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Record a single conversation turn.
     * Designed to be called with setImmediate() from the chat route so it does
     * not add latency to the HTTP response.
     */
    record(params) {
        const { sessionId, toolSequence, hadFailure, messageCount, responseLength } = params;
        try {
            this.db.insertTrace({
                id: randomUUID(),
                sessionId,
                toolSequence,
                hadFailure,
                messageCount,
                responseLength: responseLength ?? 0,
                recordedAt: Date.now(),
            });
        }
        catch (err) {
            // Swallow errors — trace collection must never crash the main process
            console.error("[TraceCollector] Failed to record trace:", err);
        }
    }
    /**
     * Returns the failure rate (0–1) over the given time window.
     * Useful for CircuitBreaker and health checks.
     */
    getRecentFailureRate(windowMs) {
        return this.db.getFailureRate(windowMs);
    }
}
