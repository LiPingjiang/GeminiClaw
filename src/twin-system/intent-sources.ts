/**
 * Intent Sources — Generate EvolutionIntents from various signals.
 *
 * Three sources:
 * 1. TraceIntentSource: Analyzes request patterns (error rates, repeated failures)
 * 2. MemoryIntentSource: Analyzes memory DB topics (hot topics, stale knowledge)
 * 3. UpstreamIntentSource: Wraps UpstreamTracker's generated intents
 */

import type { Db } from "../db/client.js"
import type { IntentSource, RawIntent } from "./intent-aggregator.js"
import type { UpstreamTracker } from "./upstream-tracker.js"
import type { ActivityRecorder } from "./factory.js"

// ── Trace Intent Source ──────────────────────────────────────────────────────

/**
 * Analyzes chat request patterns to identify behavioral issues.
 *
 * Signals:
 * - High error rate in recent sessions → behavior_fix intent
 * - Very short assistant responses → optimization intent
 * - Repeated identical user messages → behavior_fix intent
 */

export interface TraceIntentSourceConfig {
  /** Minimum sessions to analyze before generating intents */
  minSessionsForAnalysis: number
  /** Error rate threshold (0-1) above which to generate intent */
  errorRateThreshold: number
  /** Lookback window in ms (default: 24h) */
  lookbackMs: number
  /** Minimum response length below which responses are "too short" */
  shortResponseThreshold: number
}

export const DEFAULT_TRACE_CONFIG: TraceIntentSourceConfig = {
  minSessionsForAnalysis: 5,
  errorRateThreshold: 0.3,
  lookbackMs: 24 * 60 * 60 * 1000,
  shortResponseThreshold: 50,
}

export class TraceIntentSource implements IntentSource {
  readonly name = "trace-analysis"

  private db: Db
  private config: TraceIntentSourceConfig

  constructor(db: Db, config?: Partial<TraceIntentSourceConfig>) {
    this.db = db
    this.config = { ...DEFAULT_TRACE_CONFIG, ...config }
  }

  generate(): RawIntent[] {
    const intents: RawIntent[] = []
    // Format as SQLite-compatible datetime (no T, no Z) for string comparison
    const since = new Date(Date.now() - this.config.lookbackMs)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19)

    // 1. Analyze session error patterns (very short responses as proxy for errors)
    const shortResponseIntent = this.analyzeShortResponses(since)
    if (shortResponseIntent) intents.push(shortResponseIntent)

    // 2. Analyze repeated user messages (same message sent multiple times)
    const repetitionIntent = this.analyzeRepetitions(since)
    if (repetitionIntent) intents.push(repetitionIntent)

    return intents
  }

  private analyzeShortResponses(since: string): RawIntent | null {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN LENGTH(content) < ? THEN 1 ELSE 0 END) as short_count
      FROM chat_messages
      WHERE role = 'assistant' AND created_at >= ?
    `)
    const row = stmt.get(this.config.shortResponseThreshold, since) as {
      total: number
      short_count: number
    } | undefined

    if (!row || row.total < this.config.minSessionsForAnalysis) return null

    const shortRate = row.short_count / row.total
    if (shortRate < this.config.errorRateThreshold) return null

    return {
      type: "behavior_fix",
      description: `High rate of short responses detected (${(shortRate * 100).toFixed(0)}% under ${this.config.shortResponseThreshold} chars) — may indicate generation failures or truncation`,
      targetFiles: ["src/server/routes/chat.ts", "src/providers/router.ts"],
      evidence: [
        `${row.short_count}/${row.total} responses under threshold`,
        `Analysis window: last ${Math.round(this.config.lookbackMs / 3600000)}h`,
      ],
      riskLevel: "medium",
      priority: 0.7,
      dedupKey: "trace:short-responses",
    }
  }

  private analyzeRepetitions(since: string): RawIntent | null {
    // Find user messages sent 3+ times (suggests the agent failed to help)
    const stmt = this.db.prepare(`
      SELECT content, COUNT(*) as cnt
      FROM chat_messages
      WHERE role = 'user' AND created_at >= ? AND LENGTH(content) > 10
      GROUP BY content
      HAVING COUNT(*) >= 3
      ORDER BY cnt DESC
      LIMIT 5
    `)
    const rows = stmt.all(since) as Array<{ content: string; cnt: number }>

    if (rows.length === 0) return null

    const topRepeated = rows[0]
    return {
      type: "behavior_fix",
      description: `Users repeating the same message ${topRepeated.cnt} times suggests failed interactions — "${topRepeated.content.slice(0, 60)}..."`,
      targetFiles: ["src/agent/loop.ts", "src/server/routes/chat.ts"],
      evidence: rows.map((r) => `"${r.content.slice(0, 40)}..." repeated ${r.cnt}x`),
      riskLevel: "low",
      priority: 0.6,
      dedupKey: `trace:repetition:${topRepeated.content.slice(0, 20)}`,
    }
  }
}

// ── Memory Intent Source ─────────────────────────────────────────────────────

/**
 * Analyzes the memory topic system to identify optimization opportunities.
 *
 * Signals:
 * - Topics with very high access count but no summary → needs summarization optimization
 * - Many stale topics (old, never accessed) → cleanup opportunity
 * - Topic count approaching limit → memory management optimization
 */

export interface MemoryIntentSourceConfig {
  /** Topic access count above which it's "hot" */
  hotTopicThreshold: number
  /** Days without access to be considered "stale" */
  staleDaysThreshold: number
  /** Max active topics before suggesting optimization */
  topicCountWarningThreshold: number
}

export const DEFAULT_MEMORY_CONFIG: MemoryIntentSourceConfig = {
  hotTopicThreshold: 20,
  staleDaysThreshold: 14,
  topicCountWarningThreshold: 12,
}

export class MemoryIntentSource implements IntentSource {
  readonly name = "memory-analysis"

  private db: Db
  private config: MemoryIntentSourceConfig

  constructor(db: Db, config?: Partial<MemoryIntentSourceConfig>) {
    this.db = db
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config }
  }

  generate(): RawIntent[] {
    const intents: RawIntent[] = []

    // 1. Hot topics without summaries
    const hotTopicIntent = this.analyzeHotTopics()
    if (hotTopicIntent) intents.push(hotTopicIntent)

    // 2. Stale topic accumulation
    const staleIntent = this.analyzeStaleTopics()
    if (staleIntent) intents.push(staleIntent)

    // 3. Topic count pressure
    const pressureIntent = this.analyzeTopicPressure()
    if (pressureIntent) intents.push(pressureIntent)

    return intents
  }

  private analyzeHotTopics(): RawIntent | null {
    try {
      const stmt = this.db.prepare(`
        SELECT id, title, access_count
        FROM public_knowledge
        WHERE active = 1 AND access_count >= ? AND (summary IS NULL OR summary = '')
        ORDER BY access_count DESC
        LIMIT 5
      `)
      const rows = stmt.all(this.config.hotTopicThreshold) as Array<{
        id: string
        title: string
        access_count: number
      }>

      if (rows.length === 0) return null

      return {
        type: "optimization",
        description: `${rows.length} hot topic(s) without summary — high-frequency context misses may slow response quality`,
        targetFiles: ["src/memory/strategies/layered.ts"],
        evidence: rows.map(
          (r) => `Topic "${r.title}" (${r.access_count} accesses, no summary)`,
        ),
        riskLevel: "low",
        priority: 0.5,
        dedupKey: "memory:hot-topics-no-summary",
      }
    } catch {
      // Table might not exist yet
      return null
    }
  }

  private analyzeStaleTopics(): RawIntent | null {
    try {
      const staleSince = new Date(
        Date.now() - this.config.staleDaysThreshold * 24 * 60 * 60 * 1000,
      ).toISOString()

      const stmt = this.db.prepare(`
        SELECT COUNT(*) as stale_count
        FROM public_knowledge
        WHERE active = 1 AND last_accessed_at < ?
      `)
      const row = stmt.get(staleSince) as { stale_count: number } | undefined

      if (!row || row.stale_count < 3) return null

      return {
        type: "optimization",
        description: `${row.stale_count} stale topics (no access in ${this.config.staleDaysThreshold}d) — auto-archiving could free memory slots`,
        targetFiles: ["src/memory/strategies/layered.ts", "src/memory/strategy.ts"],
        evidence: [
          `${row.stale_count} topics inactive for ${this.config.staleDaysThreshold}+ days`,
          "Consider auto-archiving or compaction",
        ],
        riskLevel: "low",
        priority: 0.4,
        dedupKey: "memory:stale-topics",
      }
    } catch {
      return null
    }
  }

  private analyzeTopicPressure(): RawIntent | null {
    try {
      const stmt = this.db.prepare(`
        SELECT COUNT(*) as active_count
        FROM public_knowledge
        WHERE active = 1
      `)
      const row = stmt.get() as { active_count: number } | undefined

      if (!row || row.active_count < this.config.topicCountWarningThreshold) return null

      return {
        type: "optimization",
        description: `Active topic count (${row.active_count}) approaching capacity — memory routing may degrade`,
        targetFiles: ["src/memory/strategies/layered.ts", "src/memory/router.ts"],
        evidence: [
          `${row.active_count} active topics (warning threshold: ${this.config.topicCountWarningThreshold})`,
          "Topic routing accuracy may decrease with too many active topics",
        ],
        riskLevel: "low",
        priority: 0.45,
        dedupKey: "memory:topic-pressure",
      }
    } catch {
      return null
    }
  }
}

// ── Upstream Intent Source ────────────────────────────────────────────────────

/**
 * Wraps the UpstreamTracker to expose its generated intents as an IntentSource.
 *
 * The UpstreamTracker runs its own cron internally and generates intents
 * into an internal queue. This source simply drains that queue on each
 * `collect()` call from the IntentAggregator.
 */

export class UpstreamIntentSource implements IntentSource {
  readonly name = "upstream-sync"

  private tracker: UpstreamTracker

  constructor(tracker: UpstreamTracker) {
    this.tracker = tracker
  }

  generate(): RawIntent[] {
    const intents = this.tracker.drainIntents()
    return intents.map((intent) => ({
      type: intent.type as RawIntent["type"],
      description: intent.description,
      targetFiles: intent.targetFiles,
      evidence: intent.evidence,
      riskLevel: intent.riskLevel,
      priority: 0.6,
      dedupKey: `upstream:${intent.description.slice(0, 50)}`,
    }))
  }
}
