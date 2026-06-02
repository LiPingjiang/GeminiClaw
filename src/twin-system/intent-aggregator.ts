/**
 * IntentAggregator — Typed multi-source intent aggregation.
 *
 * Collects evolution intents from multiple sources (knowledge, upstream, manual),
 * applies deduplication, priority scoring, and outputs a ranked queue
 * ready for the EvolutionPipeline.
 *
 * Architecture:
 *   IntentSource[] → IntentAggregator → ranked EvolutionIntent[]
 */

import { randomUUID } from "crypto"
import type { EvolutionIntent, IntentType, RiskLevel } from "./types.js"

// ── Intent Source Interface ──────────────────────────────────────────────────

export interface IntentSource {
  /** Human-readable source name */
  readonly name: string
  /** Generate intents from this source */
  generate(): Promise<RawIntent[]> | RawIntent[]
}

export interface RawIntent {
  type: IntentType
  description: string
  targetFiles: string[]
  evidence: string[]
  riskLevel: RiskLevel
  /** Source-specific dedup key. Intents with same dedupKey are considered duplicates. */
  dedupKey?: string
  /** Optional priority hint from source (0-1, higher = more urgent) */
  priority?: number
}

// ── Aggregator Config ────────────────────────────────────────────────────────

export interface IntentAggregatorConfig {
  /** Maximum intents to keep in queue */
  maxQueueSize: number
  /** Auto-assign requiresHumanApproval for high risk */
  requireApprovalForHighRisk: boolean
  /** Minimum time between same dedupKey (ms, default: 24h) */
  dedupWindowMs: number
}

export const DEFAULT_AGGREGATOR_CONFIG: IntentAggregatorConfig = {
  maxQueueSize: 20,
  requireApprovalForHighRisk: true,
  dedupWindowMs: 24 * 60 * 60 * 1000,
}

// ── Priority Scoring ─────────────────────────────────────────────────────────

/**
 * Compute priority score for an intent.
 * Higher score = process sooner.
 */
export function computePriority(intent: RawIntent): number {
  let score = intent.priority ?? 0.5

  // Type-based boost
  const typeBoosts: Record<IntentType, number> = {
    behavior_fix: 0.3,
    upstream_sync: 0.2,
    optimization: 0.1,
    new_feature: 0.0,
  }
  score += typeBoosts[intent.type] ?? 0

  // Risk penalty (higher risk = slightly lower priority to prefer safe changes)
  const riskPenalty: Record<RiskLevel, number> = {
    low: 0,
    medium: -0.05,
    high: -0.15,
  }
  score += riskPenalty[intent.riskLevel] ?? 0

  // Evidence boost (more evidence = more confident)
  score += Math.min(intent.evidence.length * 0.05, 0.15)

  return Math.max(0, Math.min(1, score))
}

// ── Intent Aggregator ────────────────────────────────────────────────────────

export interface AggregatorStats {
  totalCollected: number
  totalDeduplicated: number
  queueSize: number
  lastRunAt: number | null
  sourceBreakdown: Record<string, number>
}

export class IntentAggregator {
  private sources: IntentSource[] = []
  private config: IntentAggregatorConfig
  private queue: Array<EvolutionIntent & { _priority: number }> = []
  private processedDedupKeys: Map<string, number> = new Map() // key → timestamp
  private stats: AggregatorStats = {
    totalCollected: 0,
    totalDeduplicated: 0,
    queueSize: 0,
    lastRunAt: null,
    sourceBreakdown: {},
  }

  constructor(config?: Partial<IntentAggregatorConfig>) {
    this.config = { ...DEFAULT_AGGREGATOR_CONFIG, ...config }
  }

  /**
   * Register an intent source.
   */
  addSource(source: IntentSource): void {
    this.sources.push(source)
  }

  /**
   * Remove all sources (useful for reconfiguration).
   */
  clearSources(): void {
    this.sources = []
  }

  /**
   * Collect intents from all sources, deduplicate, prioritize, and enqueue.
   * Returns newly added intents.
   */
  async collect(): Promise<EvolutionIntent[]> {
    const now = Date.now()
    const newIntents: EvolutionIntent[] = []

    // Clean up expired dedup keys
    this.cleanupDedupKeys(now)

    for (const source of this.sources) {
      let rawIntents: RawIntent[]
      try {
        rawIntents = await source.generate()
      } catch {
        // Source failure should not block others
        continue
      }

      this.stats.sourceBreakdown[source.name] =
        (this.stats.sourceBreakdown[source.name] ?? 0) + rawIntents.length
      this.stats.totalCollected += rawIntents.length

      for (const raw of rawIntents) {
        // Dedup check
        const dedupKey = raw.dedupKey ?? this.computeDedupKey(raw)
        if (this.processedDedupKeys.has(dedupKey)) {
          this.stats.totalDeduplicated++
          continue
        }

        // Convert to EvolutionIntent
        const intent: EvolutionIntent & { _priority: number } = {
          id: `intent_${randomUUID().slice(0, 12)}`,
          type: raw.type,
          description: raw.description,
          targetFiles: raw.targetFiles,
          evidence: raw.evidence,
          riskLevel: raw.riskLevel,
          requiresHumanApproval:
            raw.riskLevel === "high" && this.config.requireApprovalForHighRisk,
          createdAt: now,
          _priority: computePriority(raw),
        }

        // Mark as processed
        this.processedDedupKeys.set(dedupKey, now)

        // Add to queue (maintain priority order)
        this.queue.push(intent)
        newIntents.push(intent)
      }
    }

    // Sort by priority (descending)
    this.queue.sort((a, b) => b._priority - a._priority)

    // Trim queue if over max
    if (this.queue.length > this.config.maxQueueSize) {
      this.queue = this.queue.slice(0, this.config.maxQueueSize)
    }

    this.stats.queueSize = this.queue.length
    this.stats.lastRunAt = now

    return newIntents
  }

  /**
   * Take the next highest-priority intent from the queue.
   * Returns null if queue is empty.
   */
  next(): EvolutionIntent | null {
    const item = this.queue.shift() ?? null
    if (item) {
      this.stats.queueSize = this.queue.length
      // Strip internal _priority field
      const { _priority, ...intent } = item
      return intent
    }
    return null
  }

  /**
   * Peek at the queue without removing items.
   */
  peek(limit = 5): EvolutionIntent[] {
    return this.queue.slice(0, limit).map(({ _priority, ...intent }) => intent)
  }

  /**
   * Get current queue size.
   */
  size(): number {
    return this.queue.length
  }

  /**
   * Get aggregator stats.
   */
  getStats(): AggregatorStats {
    return { ...this.stats }
  }

  /**
   * Clear the queue (e.g., after pipeline pause).
   */
  clearQueue(): void {
    this.queue = []
    this.stats.queueSize = 0
  }

  // ── Internal Helpers ─────────────────────────────────────────────────────

  private computeDedupKey(raw: RawIntent): string {
    // Combine type + sorted target files as a rough dedup key
    const files = [...raw.targetFiles].sort().join(",")
    return `${raw.type}:${files}:${raw.description.slice(0, 50)}`
  }

  private cleanupDedupKeys(now: number): void {
    for (const [key, timestamp] of this.processedDedupKeys) {
      if (now - timestamp > this.config.dedupWindowMs) {
        this.processedDedupKeys.delete(key)
      }
    }
  }
}
