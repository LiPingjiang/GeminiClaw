// src/evolution/intent/trace-analyzer.ts
// TraceAnalyzer — Source 1 of IntentEngine
// Analyzes DB traces to find high failure rates and generate behavior_fix intents.

import { randomUUID } from "crypto"
import type { EvolutionDB } from "../db.js"
import type { Intent } from "../types.js"

export interface TraceAnalyzerConfig {
  failureRateThreshold: number  // default 0.3 (30%)
  minTraces: number             // default 5
  windowMs: number              // default 24h
}

const DEFAULT_CONFIG: TraceAnalyzerConfig = {
  failureRateThreshold: 0.3,
  minTraces: 5,
  windowMs: 24 * 60 * 60 * 1000,
}

export class TraceAnalyzer {
  private db: EvolutionDB
  private config: TraceAnalyzerConfig

  constructor(db: EvolutionDB, config?: Partial<TraceAnalyzerConfig>) {
    this.db = db
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  analyze(): Intent[] {
    const totalCount = this.db.countTraces()
    if (totalCount < this.config.minTraces) return []

    const failureRate = this.db.getFailureRate(this.config.windowMs)
    if (failureRate < this.config.failureRateThreshold) return []

    const recentTraces = this.db.getRecentTraces(20)
    const failedTraces = recentTraces.filter(t => t.hadFailure)

    const toolCounts: Record<string, number> = {}
    for (const trace of failedTraces) {
      for (const tool of trace.toolSequence) {
        toolCounts[tool] = (toolCounts[tool] ?? 0) + 1
      }
    }
    const topTool = Object.entries(toolCounts).sort((a, b) => b[1] - a[1])[0]
    const toolHint = topTool ? ` (most frequent failing tool: "${topTool[0]}")` : ""

    const pct = Math.round(failureRate * 100)
    const now = Date.now()

    const intent: Intent = {
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
      requiresHumanApproval: false,
      status: "pending",
      whyNow: `Failure rate hit ${pct}% in the last ${Math.round(this.config.windowMs / 3600000)}h window, exceeding the ${Math.round(this.config.failureRateThreshold * 100)}% threshold.`,
      discoveredContext: "Automated trace analysis",
      snoozeCount: 0,
      createdAt: now,
      updatedAt: now,
    }

    return [intent]
  }
}
