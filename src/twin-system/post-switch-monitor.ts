/**
 * PostSwitchMonitor — Auto-monitors the system after a slot switch.
 *
 * After a successful evolution switch, monitors for a configurable window:
 * - Polls health endpoint at intervals
 * - Tracks error rate from an error counter
 * - If failure rate exceeds threshold → triggers auto-rollback
 * - Emits events for observability
 *
 * All external dependencies injected via interfaces.
 */

import type { EvolutionRecord } from "./types.js"
import type { SlotManager } from "./slot-manager.js"

// ── Dependency Interfaces ────────────────────────────────────────────────────

export interface HealthProbe {
  /** Returns true if the service is healthy */
  check(): Promise<boolean>
}

export interface ErrorCounter {
  /** Get total request count in the window */
  getTotalRequests(windowMs: number): number
  /** Get error count in the window */
  getErrorCount(windowMs: number): number
}

export interface MonitorLogger {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

export interface MonitorEvent {
  type:
    | "monitoring_started"
    | "health_check"
    | "error_rate_check"
    | "rollback_triggered"
    | "monitoring_completed"
  timestamp: number
  data?: Record<string, unknown>
}

export type MonitorEventHandler = (event: MonitorEvent) => void

// ── Config ───────────────────────────────────────────────────────────────────

export interface PostSwitchMonitorConfig {
  /** Total monitoring window duration (ms) */
  monitorWindowMs: number
  /** Interval between health checks (ms) */
  healthCheckIntervalMs: number
  /** Interval between error rate checks (ms) */
  errorRateCheckIntervalMs: number
  /** Error rate threshold to trigger rollback (0-1) */
  failureRateThreshold: number
  /** Minimum requests before error rate is meaningful */
  minRequestsForRateCheck: number
  /** Max consecutive health check failures before rollback */
  maxConsecutiveHealthFailures: number
}

export const DEFAULT_MONITOR_CONFIG: PostSwitchMonitorConfig = {
  monitorWindowMs: 5 * 60 * 1000, // 5 minutes
  healthCheckIntervalMs: 15_000, // 15 seconds
  errorRateCheckIntervalMs: 30_000, // 30 seconds
  failureRateThreshold: 0.1,
  minRequestsForRateCheck: 10,
  maxConsecutiveHealthFailures: 3,
}

// ── Monitor Result ───────────────────────────────────────────────────────────

export interface MonitorResult {
  passed: boolean
  durationMs: number
  rolledBack: boolean
  rollbackReason?: string
  healthChecks: number
  healthFailures: number
  maxErrorRate: number
}

// ── PostSwitchMonitor ────────────────────────────────────────────────────────

export interface PostSwitchMonitorDeps {
  healthProbe: HealthProbe
  errorCounter: ErrorCounter
  slotManager: SlotManager
  config?: Partial<PostSwitchMonitorConfig>
  logger: MonitorLogger
  onEvent?: MonitorEventHandler
}

export class PostSwitchMonitor {
  private readonly healthProbe: HealthProbe
  private readonly errorCounter: ErrorCounter
  private readonly slotManager: SlotManager
  private readonly config: PostSwitchMonitorConfig
  private readonly logger: MonitorLogger
  private readonly onEvent?: MonitorEventHandler

  private aborted = false

  constructor(deps: PostSwitchMonitorDeps) {
    this.healthProbe = deps.healthProbe
    this.errorCounter = deps.errorCounter
    this.slotManager = deps.slotManager
    this.config = { ...DEFAULT_MONITOR_CONFIG, ...deps.config }
    this.logger = deps.logger
    this.onEvent = deps.onEvent
  }

  /**
   * Start monitoring after a switch. Resolves when window completes or rollback occurs.
   */
  async monitor(switchRecord: EvolutionRecord): Promise<MonitorResult> {
    const start = Date.now()
    this.aborted = false

    this.emit({
      type: "monitoring_started",
      timestamp: start,
      data: { intentId: switchRecord.intentId, windowMs: this.config.monitorWindowMs },
    })

    this.logger.info(
      "Post-switch monitoring started for intent %s (window: %dms)",
      switchRecord.intentId,
      this.config.monitorWindowMs,
    )

    let healthChecks = 0
    let healthFailures = 0
    let consecutiveFailures = 0
    let maxErrorRate = 0

    const deadline = start + this.config.monitorWindowMs
    let nextHealthCheck = start + this.config.healthCheckIntervalMs
    let nextErrorRateCheck = start + this.config.errorRateCheckIntervalMs

    while (Date.now() < deadline && !this.aborted) {
      const now = Date.now()

      // Health check
      if (now >= nextHealthCheck) {
        healthChecks++
        const healthy = await this.healthProbe.check()

        this.emit({
          type: "health_check",
          timestamp: now,
          data: { healthy, consecutiveFailures },
        })

        if (healthy) {
          consecutiveFailures = 0
        } else {
          healthFailures++
          consecutiveFailures++
          this.logger.warn(
            "Health check failed (%d consecutive)",
            consecutiveFailures,
          )

          if (
            consecutiveFailures >= this.config.maxConsecutiveHealthFailures
          ) {
            return this.triggerRollback(
              switchRecord,
              `${consecutiveFailures} consecutive health check failures`,
              start,
              healthChecks,
              healthFailures,
              maxErrorRate,
            )
          }
        }
        nextHealthCheck = now + this.config.healthCheckIntervalMs
      }

      // Error rate check
      if (now >= nextErrorRateCheck) {
        const totalRequests = this.errorCounter.getTotalRequests(
          this.config.monitorWindowMs,
        )
        const errorCount = this.errorCounter.getErrorCount(
          this.config.monitorWindowMs,
        )

        if (totalRequests >= this.config.minRequestsForRateCheck) {
          const errorRate = errorCount / totalRequests
          maxErrorRate = Math.max(maxErrorRate, errorRate)

          this.emit({
            type: "error_rate_check",
            timestamp: now,
            data: { errorRate, totalRequests, errorCount },
          })

          if (errorRate > this.config.failureRateThreshold) {
            this.logger.warn(
              "Error rate %.2f exceeds threshold %.2f",
              errorRate,
              this.config.failureRateThreshold,
            )
            return this.triggerRollback(
              switchRecord,
              `Error rate ${errorRate.toFixed(3)} exceeds threshold ${this.config.failureRateThreshold}`,
              start,
              healthChecks,
              healthFailures,
              maxErrorRate,
            )
          }
        }
        nextErrorRateCheck = now + this.config.errorRateCheckIntervalMs
      }

      // Sleep a bit to avoid busy-wait
      await this.sleep(Math.min(5000, this.config.healthCheckIntervalMs / 2))
    }

    // Monitoring window completed successfully
    const durationMs = Date.now() - start
    this.logger.info(
      "Post-switch monitoring completed successfully (%dms, %d health checks, max error rate: %.3f)",
      durationMs,
      healthChecks,
      maxErrorRate,
    )

    this.emit({
      type: "monitoring_completed",
      timestamp: Date.now(),
      data: { passed: true, durationMs, healthChecks, healthFailures, maxErrorRate },
    })

    return {
      passed: true,
      durationMs,
      rolledBack: false,
      healthChecks,
      healthFailures,
      maxErrorRate,
    }
  }

  /**
   * Abort monitoring early (e.g., manual intervention).
   */
  abort(): void {
    this.aborted = true
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private triggerRollback(
    switchRecord: EvolutionRecord,
    reason: string,
    startTime: number,
    healthChecks: number,
    healthFailures: number,
    maxErrorRate: number,
  ): MonitorResult {
    this.logger.error(
      "Rolling back intent %s: %s",
      switchRecord.intentId,
      reason,
    )

    this.emit({
      type: "rollback_triggered",
      timestamp: Date.now(),
      data: { intentId: switchRecord.intentId, reason },
    })

    try {
      this.slotManager.rollback()
      this.logger.info("Rollback successful")
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.logger.error("Rollback failed: %s", errMsg)
    }

    return {
      passed: false,
      durationMs: Date.now() - startTime,
      rolledBack: true,
      rollbackReason: reason,
      healthChecks,
      healthFailures,
      maxErrorRate,
    }
  }

  private emit(event: MonitorEvent): void {
    this.onEvent?.(event)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
