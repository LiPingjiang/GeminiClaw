import { randomUUID } from "crypto"
import type { EvolutionDB } from "../db.js"
import type { Intent, RiskLevel } from "../types.js"
import type { ProviderRouter } from "../../providers/router.js"
import { TraceAnalyzer } from "./trace-analyzer.js"
import { MemoryTopicsAnalyzer } from "./memory-topics-analyzer.js"
import { UpstreamSyncSource } from "./upstream-sync.js"
import type { UpstreamRepo } from "./upstream-sync.js"

export interface IntentEngineConfig {
  db: EvolutionDB
  providerRouter: ProviderRouter
  repoRoot: string
  memoryDbPath: string
  upstreamRepos?: UpstreamRepo[]
}

export class IntentEngine {
  private db: EvolutionDB
  private traceAnalyzer: TraceAnalyzer
  private memoryAnalyzer: MemoryTopicsAnalyzer
  private upstreamSource: UpstreamSyncSource

  constructor(config: IntentEngineConfig) {
    this.db = config.db
    this.traceAnalyzer = new TraceAnalyzer(config.db)
    this.memoryAnalyzer = new MemoryTopicsAnalyzer(config.memoryDbPath)
    this.upstreamSource = new UpstreamSyncSource({
      db: config.db,
      providerRouter: config.providerRouter,
      repoRoot: config.repoRoot,
      upstreamRepos: config.upstreamRepos ?? [],
    })
  }

  /**
   * Run all three sources, deduplicate, sort by risk (low first), write to DB.
   * Returns the number of new intents inserted.
   */
  async generateIntents(): Promise<number> {
    const candidates: Intent[] = [
      ...this.traceAnalyzer.analyze(),
      ...this.memoryAnalyzer.analyze(),
      ...(await this.upstreamSource.check()),
    ]

    const newIntents = candidates.filter(
      intent => !this.db.hasPendingIntentWithDescription(intent.description)
    )

    const riskOrder: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 }
    newIntents.sort((a, b) => riskOrder[a.riskLevel] - riskOrder[b.riskLevel])

    for (const intent of newIntents) {
      this.db.insertIntent(intent)
    }

    return newIntents.length
  }

  /**
   * Add a user-triggered intent. Always requires human approval.
   * Returns the new intent id.
   */
  addUserIntent(params: {
    description: string
    targetFiles: string[]
    riskLevel: RiskLevel
    evidence?: string[]
  }): string {
    const now = Date.now()
    const intent: Intent = {
      id: randomUUID(),
      type: "new_feature",
      description: params.description,
      targetFiles: params.targetFiles,
      evidence: params.evidence ?? ["User-requested"],
      riskLevel: params.riskLevel,
      requiresHumanApproval: true,
      status: "pending",
      whyNow: "User explicitly requested this improvement",
      discoveredContext: "User instruction via chat/API",
      snoozeCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    this.db.insertIntent(intent)
    return intent.id
  }
}
