/**
 * EvolutionMetrics — Observability for the twin-system evolution engine.
 *
 * Collects and exposes:
 * - Cycle counts (success, failure, skipped)
 * - Timing data (average/p95 cycle duration)
 * - Rollback counts
 * - Daily cycle budget tracking (maxCyclesPerDay)
 * - Last N cycle records for inspection
 *
 * This is an in-memory collector. For production, metrics can be
 * exported to Prometheus/StatsD via the snapshot() method.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface CycleRecord {
  intentId: string
  intentType: string
  trigger: string
  startedAt: number
  finishedAt: number
  durationMs: number
  success: boolean
  abortReason?: string
  changedFiles: string[]
  rolled_back: boolean
}

export interface MetricsSnapshot {
  /** Total cycles since process start */
  totalCycles: number
  /** Successful evolutions */
  successCount: number
  /** Failed evolutions */
  failureCount: number
  /** Skipped (no intent available) */
  skippedCount: number
  /** Rollback events from PostSwitchMonitor */
  rollbackCount: number
  /** Cycles executed today (for budget tracking) */
  cyclesToday: number
  /** Average cycle duration (ms) — last 20 cycles */
  avgDurationMs: number
  /** P95 cycle duration (ms) — last 20 cycles */
  p95DurationMs: number
  /** Last cycle timestamp (ISO) */
  lastCycleAt: string | null
  /** Last N cycle records */
  recentCycles: CycleRecord[]
  /** Current daily budget remaining (null if unlimited) */
  dailyBudgetRemaining: number | null
  /** Uptime in seconds */
  uptimeSeconds: number
}

export interface MetricsConfig {
  /** Max cycles allowed per calendar day. 0 = unlimited */
  maxCyclesPerDay: number
  /** How many recent cycle records to keep */
  recentHistorySize: number
}

export const DEFAULT_METRICS_CONFIG: MetricsConfig = {
  maxCyclesPerDay: 0,
  recentHistorySize: 20,
}

// ── Implementation ───────────────────────────────────────────────────────────

export class EvolutionMetrics {
  private config: MetricsConfig
  private startTime = Date.now()
  private successCount = 0
  private failureCount = 0
  private skippedCount = 0
  private rollbackCount = 0
  private recentCycles: CycleRecord[] = []
  /** Track daily budget: { dateKey: count } */
  private dailyCounts: Map<string, number> = new Map()

  constructor(config?: Partial<MetricsConfig>) {
    this.config = { ...DEFAULT_METRICS_CONFIG, ...config }
  }

  /**
   * Record a completed evolution cycle.
   */
  recordCycle(record: Omit<CycleRecord, "durationMs" | "finishedAt">  & { finishedAt?: number }): void {
    const finishedAt = record.finishedAt ?? Date.now()
    const durationMs = finishedAt - record.startedAt
    const full: CycleRecord = {
      ...record,
      finishedAt,
      durationMs,
    }

    if (record.success) {
      this.successCount++
    } else {
      this.failureCount++
    }

    this.recentCycles.push(full)
    if (this.recentCycles.length > this.config.recentHistorySize) {
      this.recentCycles.shift()
    }

    // Track daily count
    const dayKey = this.todayKey()
    this.dailyCounts.set(dayKey, (this.dailyCounts.get(dayKey) ?? 0) + 1)

    // Prune old daily entries (keep last 3 days)
    this.pruneDailyCounts()
  }

  /**
   * Record a skipped trigger (no intent available).
   */
  recordSkipped(): void {
    this.skippedCount++
  }

  /**
   * Record a rollback event from PostSwitchMonitor.
   */
  recordRollback(): void {
    this.rollbackCount++
  }

  /**
   * Check if daily budget allows another cycle.
   * Returns true if cycle is allowed.
   */
  canRunToday(): boolean {
    if (this.config.maxCyclesPerDay <= 0) return true
    const todayCount = this.dailyCounts.get(this.todayKey()) ?? 0
    return todayCount < this.config.maxCyclesPerDay
  }

  /**
   * Get how many cycles remain today.
   * Returns null if unlimited.
   */
  remainingToday(): number | null {
    if (this.config.maxCyclesPerDay <= 0) return null
    const todayCount = this.dailyCounts.get(this.todayKey()) ?? 0
    return Math.max(0, this.config.maxCyclesPerDay - todayCount)
  }

  /**
   * Get a complete metrics snapshot (for /v1/health or /v1/evolution/status).
   */
  snapshot(): MetricsSnapshot {
    const durations = this.recentCycles.map((c) => c.durationMs)
    const avgDurationMs = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0
    const p95DurationMs = durations.length > 0
      ? percentile(durations, 0.95)
      : 0

    const lastCycle = this.recentCycles.length > 0
      ? this.recentCycles[this.recentCycles.length - 1]
      : null

    return {
      totalCycles: this.successCount + this.failureCount,
      successCount: this.successCount,
      failureCount: this.failureCount,
      skippedCount: this.skippedCount,
      rollbackCount: this.rollbackCount,
      cyclesToday: this.dailyCounts.get(this.todayKey()) ?? 0,
      avgDurationMs,
      p95DurationMs,
      lastCycleAt: lastCycle ? new Date(lastCycle.finishedAt).toISOString() : null,
      recentCycles: [...this.recentCycles],
      dailyBudgetRemaining: this.remainingToday(),
      uptimeSeconds: Math.round((Date.now() - this.startTime) / 1000),
    }
  }

  /**
   * Reset all metrics (useful for testing).
   */
  reset(): void {
    this.successCount = 0
    this.failureCount = 0
    this.skippedCount = 0
    this.rollbackCount = 0
    this.recentCycles = []
    this.dailyCounts.clear()
    this.startTime = Date.now()
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10) // "YYYY-MM-DD"
  }

  private pruneDailyCounts(): void {
    if (this.dailyCounts.size <= 3) return
    const keys = [...this.dailyCounts.keys()].sort()
    while (keys.length > 3) {
      this.dailyCounts.delete(keys.shift()!)
    }
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.ceil(p * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}
