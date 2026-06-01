/**
 * EvolutionBridge — Connects Knowledge Layer ↔ Twin-System Evolution Pipeline.
 *
 * Responsibilities:
 * 1. After Curator runs, scan KnowledgeStore for evolution-worthy insights
 * 2. Convert IntentCandidates into proper EvolutionIntents
 * 3. Feed intents into the Twin-System pipeline (or queue for manual approval)
 * 4. Track which knowledge entries have already spawned intents (dedup)
 *
 * Architecture:
 *   KnowledgeStore → KnowledgeIntentSource → EvolutionBridge → EvolutionPipeline
 */

import { randomUUID } from "crypto"
import type { KnowledgeStore } from "./store.js"
import { KnowledgeIntentSource, type IntentCandidate, type KnowledgeIntentSourceConfig } from "./intent-source.js"
import type { EvolutionIntent, RiskLevel, IntentType } from "../../twin-system/types.js"

// ── Types ────────────────────────────────────────────────────────────────────

export interface EvolutionBridgeConfig {
  /** Knowledge intent source config overrides */
  sourceConfig?: Partial<KnowledgeIntentSourceConfig>
  /** Auto-approve low-risk intents? (default: true) */
  autoApproveLowRisk: boolean
  /** Maximum pending intents in queue (default: 10) */
  maxQueueSize: number
  /** Callback when new intents are generated */
  onIntentsGenerated?: (intents: EvolutionIntent[]) => void | Promise<void>
}

export const DEFAULT_BRIDGE_CONFIG: EvolutionBridgeConfig = {
  autoApproveLowRisk: true,
  maxQueueSize: 10,
}

export interface BridgeStats {
  totalGenerated: number
  totalConverted: number
  pendingQueue: number
  lastRunAt: number | null
  deduplicatedCount: number
}

// ── Bridge ───────────────────────────────────────────────────────────────────

export class EvolutionBridge {
  private store: KnowledgeStore
  private source: KnowledgeIntentSource
  private config: EvolutionBridgeConfig

  /** Intent queue for pipeline consumption */
  private intentQueue: EvolutionIntent[] = []
  /** Track which knowledge entry IDs have already produced intents */
  private processedEntryIds: Set<string> = new Set()
  /** Stats */
  private stats: BridgeStats = {
    totalGenerated: 0,
    totalConverted: 0,
    pendingQueue: 0,
    lastRunAt: null,
    deduplicatedCount: 0,
  }

  constructor(store: KnowledgeStore, config?: Partial<EvolutionBridgeConfig>) {
    this.store = store
    this.config = { ...DEFAULT_BRIDGE_CONFIG, ...config }
    this.source = new KnowledgeIntentSource(store, this.config.sourceConfig)
  }

  /**
   * Scan the knowledge store and generate evolution intents.
   * Call this after Curator.run() or on a schedule.
   */
  async generateIntents(): Promise<EvolutionIntent[]> {
    const candidates = this.source.analyze()
    this.stats.totalGenerated += candidates.length

    // Dedup: filter out candidates whose source entries were already processed
    const fresh = candidates.filter((c) => {
      const allProcessed = c.sourceEntryIds.every((id) => this.processedEntryIds.has(id))
      if (allProcessed) {
        this.stats.deduplicatedCount++
        return false
      }
      return true
    })

    // Convert to EvolutionIntents
    const intents = fresh.map((c) => this.toEvolutionIntent(c))
    this.stats.totalConverted += intents.length

    // Mark source entries as processed
    for (const candidate of fresh) {
      for (const id of candidate.sourceEntryIds) {
        this.processedEntryIds.add(id)
      }
    }

    // Queue management: respect max size
    const capacity = this.config.maxQueueSize - this.intentQueue.length
    const toQueue = intents.slice(0, Math.max(0, capacity))
    this.intentQueue.push(...toQueue)
    this.stats.pendingQueue = this.intentQueue.length
    this.stats.lastRunAt = Date.now()

    // Notify listener
    if (toQueue.length > 0 && this.config.onIntentsGenerated) {
      await this.config.onIntentsGenerated(toQueue)
    }

    return toQueue
  }

  /**
   * Consume the next intent from the queue.
   * Used by the evolution pipeline runner.
   */
  dequeueIntent(): EvolutionIntent | undefined {
    const intent = this.intentQueue.shift()
    this.stats.pendingQueue = this.intentQueue.length
    return intent
  }

  /**
   * Peek at all pending intents without consuming.
   */
  peekQueue(): EvolutionIntent[] {
    return [...this.intentQueue]
  }

  /**
   * Drain all pending intents.
   */
  drainQueue(): EvolutionIntent[] {
    const all = [...this.intentQueue]
    this.intentQueue = []
    this.stats.pendingQueue = 0
    return all
  }

  /**
   * Get bridge statistics.
   */
  getStats(): BridgeStats {
    return { ...this.stats }
  }

  /**
   * Reset processed entries tracker (e.g., after knowledge lifecycle clears old entries).
   */
  resetProcessedEntries(): void {
    this.processedEntryIds.clear()
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private toEvolutionIntent(candidate: IntentCandidate): EvolutionIntent {
    const requiresApproval =
      !this.config.autoApproveLowRisk || candidate.riskLevel !== "low"

    return {
      id: `ki_${randomUUID().slice(0, 12)}`,
      type: candidate.type as IntentType,
      description: candidate.description,
      targetFiles: candidate.targetFiles,
      evidence: candidate.evidence,
      riskLevel: candidate.riskLevel as RiskLevel,
      requiresHumanApproval: requiresApproval,
      createdAt: Date.now(),
    }
  }
}
