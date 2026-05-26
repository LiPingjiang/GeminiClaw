// @ts-nocheck
// src/evolution/intent/trace-analyzer.ts
// TraceAnalyzer — Source 1 of IntentEngine
// Analyzes DB traces to find high failure rates and generate behavior_fix intents.
import { randomUUID } from "crypto";
const DEFAULT_CONFIG = {
    failureRateThreshold: 0.3,
    minTraces: 5,
    windowMs: 24 * 60 * 60 * 1000,
};
export class TraceAnalyzer {
    db;
    config;
    constructor(db, config) {
        this.db = db;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    analyze() {
        const totalCount = this.db.countTraces();
        if (totalCount < this.config.minTraces)
            return [];
        const failureRate = this.db.getFailureRate(this.config.windowMs);
        if (failureRate < this.config.failureRateThreshold)
            return [];
        const recentTraces = this.db.getRecentTraces(20);
        const failedTraces = recentTraces.filter(t => t.hadFailure);
        const toolCounts = {};
        for (const trace of failedTraces) {
            for (const tool of trace.toolSequence) {
                toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
            }
        }
        const topTool = Object.entries(toolCounts).sort((a, b) => b[1] - a[1])[0];
        const toolHint = topTool ? ` (most frequent failing tool: "${topTool[0]}")` : "";
        const pct = Math.round(failureRate * 100);
        const now = Date.now();
        const intent = {
            id: randomUUID(),
            type: "behavior_fix",
            description: `High failure rate detected in recent conversations: ${pct}% of traces had errors${toolHint}. Investigate and fix error handling.`,
            targetFiles: ["src/agent/loop.ts", "src/tools/exec.ts"],
            evidence: [
                `Failure rate: ${pct}% (threshold: ${Math.round(this.config.failureRateThreshold * 100)}%)`,
                `Sample size: ${totalCount} traces`,
                `Failed traces in last 20: ${failedTraces.length}`,
                ...(topTool ? [`Top failing tool: "${topTool[0]}" (${topTool[1]} occurrences)`] : []),
            ],
            riskLevel: "low",
            status: "pending",
            createdAt: now,
            updatedAt: now,
        };
        return [intent];
    }
}
