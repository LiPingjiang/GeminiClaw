// src/evolution/circuit-breaker/circuit-breaker.ts
// CircuitBreaker: monitors post-switch behavior and triggers rollback if quality degrades.
//
// Monitoring logic (every checkIntervalMs):
//   1. Read recent traces from DB (last 5 minutes)
//   2. If failureRate > failureThreshold → trigger rollback + open circuit
//   3. After monitoringWindowMs → stop monitoring (switch is stable)
//
// Protection rules (canEvolve):
//   - circuit open → denied
//   - target file in PROTECTED_PATHS → denied
//   - same file evolved > maxEvolutionsPerFile24h times in 24h → denied

import type { EvolutionDB } from "../db.js"
import type { Switcher } from "../switcher/switcher.js"
import type { CircuitBreakerState, EvolutionConfig } from "../types.js"
import type { Logger } from "../index.js"

// ---------------------------------------------------------------------------
// Protected paths — these files/directories cannot be auto-evolved
// ---------------------------------------------------------------------------

export const PROTECTED_PATHS = [
  "src/evolution/",
  "src/config/",
  ".gemini-data/",
]

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

export interface CircuitBreakerParams {
  db: EvolutionDB
  switcher: Switcher
  config: EvolutionConfig["circuitBreaker"]
  logger: Logger
}

export class CircuitBreaker {
  private db: EvolutionDB
  private switcher: Switcher
  private config: EvolutionConfig["circuitBreaker"]
  private logger: Logger

  private state: CircuitBreakerState = { isOpen: false }
  private monitoringTimer: ReturnType<typeof setInterval> | null = null
  private monitoringDeadlineTimer: ReturnType<typeof setTimeout> | null = null

  constructor(params: CircuitBreakerParams) {
    this.db = params.db
    this.switcher = params.switcher
    this.config = params.config
    this.logger = params.logger
  }

  /**
   * Start monitoring after a successful switch.
   * Runs health checks every checkIntervalMs for monitoringWindowMs.
   * Non-blocking: returns immediately.
   */
  startMonitoring(intentId: string): void {
    // Stop any existing monitoring
    this.stopMonitoring()

    this.state = {
      ...this.state,
      monitoringIntentId: intentId,
    }

    this.logger.info(
      "CircuitBreaker: starting monitoring for intent %s (window=%dms, interval=%dms)",
      intentId,
      this.config.monitoringWindowMs,
      this.config.checkIntervalMs
    )

    // Periodic health check
    this.monitoringTimer = setInterval(() => {
      void this.checkHealth()
    }, this.config.checkIntervalMs)

    // Monitoring window deadline — stop after monitoringWindowMs
    this.monitoringDeadlineTimer = setTimeout(() => {
      this.logger.info(
        "CircuitBreaker: monitoring window expired for intent %s — switch is stable",
        intentId
      )
      this.stopMonitoring()
    }, this.config.monitoringWindowMs)
  }

  /**
   * Stop monitoring (clears all timers).
   */
  stopMonitoring(): void {
    if (this.monitoringTimer !== null) {
      clearInterval(this.monitoringTimer)
      this.monitoringTimer = null
    }
    if (this.monitoringDeadlineTimer !== null) {
      clearTimeout(this.monitoringDeadlineTimer)
      this.monitoringDeadlineTimer = null
    }

    if (this.state.monitoringIntentId) {
      this.logger.info(
        "CircuitBreaker: stopped monitoring for intent %s",
        this.state.monitoringIntentId
      )
      this.state = { ...this.state, monitoringIntentId: undefined }
    }
  }

  /**
   * Check whether a new evolution is allowed.
   * Returns { allowed: true } or { allowed: false, reason: string }.
   */
  canEvolve(targetFiles: string[]): { allowed: boolean; reason?: string } {
    // Rule 1: circuit open
    if (this.state.isOpen) {
      return { allowed: false, reason: "circuit_open" }
    }

    // Rule 2: protected paths
    for (const file of targetFiles) {
      for (const protectedPath of PROTECTED_PATHS) {
        if (file.startsWith(protectedPath) || file === protectedPath) {
          return {
            allowed: false,
            reason: `protected_path: ${file} matches ${protectedPath}`,
          }
        }
      }
    }

    // Rule 3: evolution frequency limit (24h)
    const windowMs = 24 * 60 * 60 * 1000
    for (const file of targetFiles) {
      const count = this.db.getEvolutionCountForFile(file, windowMs)
      if (count >= this.config.maxEvolutionsPerFile24h) {
        return {
          allowed: false,
          reason: `evolution_frequency_limit: ${file} evolved ${count} times in 24h (max ${this.config.maxEvolutionsPerFile24h})`,
        }
      }
    }

    return { allowed: true }
  }

  /**
   * Get current circuit breaker state.
   */
  getState(): CircuitBreakerState {
    return { ...this.state }
  }

  // ---------------------------------------------------------------------------
  // Private: health check
  // ---------------------------------------------------------------------------

  private async checkHealth(): Promise<void> {
    const windowMs = 5 * 60 * 1000  // 5 minutes
    const failureRate = this.db.getFailureRate(windowMs)

    this.logger.info(
      "CircuitBreaker: health check — failureRate=%.2f (threshold=%.2f)",
      failureRate,
      this.config.failureThreshold
    )

    if (failureRate > this.config.failureThreshold) {
      this.logger.warn(
        "CircuitBreaker: failureRate=%.2f exceeds threshold=%.2f — triggering rollback",
        failureRate,
        this.config.failureThreshold
      )

      // Stop monitoring before rollback to avoid re-entrant checks
      const intentId = this.state.monitoringIntentId
      this.stopMonitoring()

      // Open the circuit
      this.state = {
        isOpen: true,
        openedAt: Date.now(),
        openReason: `high_failure_rate: ${failureRate.toFixed(2)}`,
      }

      // Record in DB
      this.db.insertEvolutionRecord({
        intentId: intentId ?? "unknown",
        type: "rollback",
        fromSlot: "a",
        toSlot: "b",
        changedFiles: [],
        recordedAt: Date.now(),
      })

      // Trigger rollback
      try {
        const rollbackResult = await this.switcher.rollback()
        if (rollbackResult.success) {
          this.logger.info("CircuitBreaker: rollback successful")
        } else {
          this.logger.error("CircuitBreaker: rollback failed: %s", rollbackResult.error)
        }
      } catch (err) {
        this.logger.error("CircuitBreaker: rollback threw: %s", (err as Error).message)
      }
    }
  }
}
