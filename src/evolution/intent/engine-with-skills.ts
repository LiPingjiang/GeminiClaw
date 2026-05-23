// src/evolution/intent/engine-with-skills.ts
// 集成 Skill 支持的 IntentEngine

import { randomUUID } from "crypto"
import type { EvolutionDB } from "../db.js"
import type { Intent, RiskLevel } from "../types.js"
import type { ProviderRouter } from "../../providers/router.js"
import { TraceAnalyzer } from "./trace-analyzer.js"
import { MemoryTopicsAnalyzer } from "./memory-topics-analyzer.js"
import { UpstreamSyncSource } from "./upstream-sync.js"
import type { UpstreamRepo } from "./upstream-sync.js"
import { SkillAnalyzer } from "../../skills/analyzer.js"

export interface IntentEngineConfig {
  db: EvolutionDB
  providerRouter: ProviderRouter
  repoRoot: string
  memoryDbPath: string
  skillsDir: string  // 新增：技能目录
  upstreamRepos?: UpstreamRepo[]
}

export class IntentEngine {
  private db: EvolutionDB
  private traceAnalyzer: TraceAnalyzer
  private memoryAnalyzer: MemoryTopicsAnalyzer
  private upstreamSource: UpstreamSyncSource
  private skillAnalyzer: SkillAnalyzer

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
    this.skillAnalyzer = new SkillAnalyzer(config.skillsDir, config.db)
  }

  /**
   * 运行所有分析源，包括技能分析
   */
  async generateIntents(): Promise<number> {
    const candidates: Intent[] = [
      ...this.traceAnalyzer.analyze(),
      ...this.memoryAnalyzer.analyze(),
      ...(await this.upstreamSource.check()),
      ...this.skillAnalyzer.analyze(),  // 新增：技能分析
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
   * 添加用户触发的意图
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
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }
    this.db.insertIntent(intent)
    return intent.id
  }

  /**
   * 初始化技能系统
   */
  initializeSkills(): void {
    this.skillAnalyzer.registerSkillFiles()
  }
}