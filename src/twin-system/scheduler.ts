/**
 * SchedulerRunner — Unified scheduler for the evolution engine.
 *
 * Determines WHEN to trigger evolution cycles:
 * 1. Idle detection: trigger when system has been idle for X seconds
 * 2. Cron-based: trigger on a regular interval (e.g., every 30 min) OR at a
 *    fixed daily hour (e.g., every day at 03:00 server-local time)
 * 3. Manual: explicit trigger API
 *
 * The scheduler does NOT run evolution itself — it calls a callback
 * that the pipeline owner provides.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type SchedulerTriggerReason = "idle" | "cron" | "manual"

export interface SchedulerEvent {
  type: "trigger" | "started" | "stopped" | "paused" | "resumed"
  reason?: SchedulerTriggerReason
  timestamp: number
}

export type SchedulerEventHandler = (event: SchedulerEvent) => void

export interface ActivityTracker {
  /** Returns ms since last activity (request, tool call, etc.) */
  getIdleMs(): number
}

export interface SchedulerConfig {
  /** Minimum idle time before triggering evolution (ms) */
  idleThresholdMs: number
  /** Cron interval (ms). Set to 0 to disable cron triggers. */
  cronIntervalMs: number
  /**
   * Fixed daily trigger hour (0-23, server-local time). When set, the cron
   * trigger fires once per day at this hour instead of on a fixed interval.
   * Takes precedence over cronIntervalMs. Leave undefined for interval mode.
   */
  dailyAtHour?: number
  /** Poll interval for checking idle state (ms) */
  pollIntervalMs: number
  /** Minimum time between any two triggers (ms) — cooldown */
  cooldownMs: number
  /** Whether idle trigger is enabled */
  idleEnabled: boolean
  /** Whether cron trigger is enabled */
  cronEnabled: boolean
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  idleThresholdMs: 5 * 60 * 1000, // 5 minutes idle
  cronIntervalMs: 30 * 60 * 1000, // every 30 minutes
  pollIntervalMs: 30_000, // check every 30 seconds
  cooldownMs: 10 * 60 * 1000, // 10 minute cooldown between triggers
  idleEnabled: true,
  cronEnabled: true,
}

export interface SchedulerLogger {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
}

// ── Trigger Callback ─────────────────────────────────────────────────────────

/**
 * Called when the scheduler decides to trigger an evolution cycle.
 * Returns true if the cycle was accepted/started, false if rejected.
 */
export type TriggerCallback = (reason: SchedulerTriggerReason) => Promise<boolean> | boolean

// ── SchedulerRunner ──────────────────────────────────────────────────────────

export interface SchedulerRunnerDeps {
  activityTracker: ActivityTracker
  onTrigger: TriggerCallback
  config?: Partial<SchedulerConfig>
  logger: SchedulerLogger
  onEvent?: SchedulerEventHandler
}

export class SchedulerRunner {
  private readonly activityTracker: ActivityTracker
  private readonly onTrigger: TriggerCallback
  private readonly config: SchedulerConfig
  private readonly logger: SchedulerLogger
  private readonly onEvent?: SchedulerEventHandler

  private running = false
  private paused = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private cronTimer: ReturnType<typeof setInterval> | null = null
  private dailyTimer: ReturnType<typeof setTimeout> | null = null
  private lastTriggerAt = 0

  constructor(deps: SchedulerRunnerDeps) {
    this.activityTracker = deps.activityTracker
    this.onTrigger = deps.onTrigger
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...deps.config }
    this.logger = deps.logger
    this.onEvent = deps.onEvent
  }

  /**
   * Start the scheduler. Begins polling for idle state and/or cron.
   */
  start(): void {
    if (this.running) return

    this.running = true
    this.paused = false

    const dailyMode =
      this.config.cronEnabled && this.config.dailyAtHour !== undefined
    this.emit({ type: "started", timestamp: Date.now() })
    this.logger.info(
      "Scheduler started (idle=%s, cron=%s, mode=%s)",
      this.config.idleEnabled,
      this.config.cronEnabled,
      dailyMode ? `daily@${this.config.dailyAtHour}:00` : "interval",
    )

    // Idle polling
    if (this.config.idleEnabled) {
      this.pollTimer = setInterval(
        () => this.checkIdle(),
        this.config.pollIntervalMs,
      )
    }

    // Cron: daily-at-hour takes precedence over fixed interval.
    if (this.config.cronEnabled) {
      if (dailyMode) {
        this.scheduleNextDaily()
      } else if (this.config.cronIntervalMs > 0) {
        this.cronTimer = setInterval(
          () => this.cronTick(),
          this.config.cronIntervalMs,
        )
      }
    }
  }

  /**
   * Stop the scheduler completely.
   */
  stop(): void {
    if (!this.running) return

    this.running = false
    this.clearTimers()

    this.emit({ type: "stopped", timestamp: Date.now() })
    this.logger.info("Scheduler stopped")
  }

  /**
   * Pause triggers (timers keep running but no triggers fire).
   */
  pause(): void {
    if (this.paused) return
    this.paused = true
    this.emit({ type: "paused", timestamp: Date.now() })
    this.logger.info("Scheduler paused")
  }

  /**
   * Resume triggers after pause.
   */
  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.emit({ type: "resumed", timestamp: Date.now() })
    this.logger.info("Scheduler resumed")
  }

  /**
   * Manually trigger an evolution cycle.
   */
  async triggerManual(): Promise<boolean> {
    return this.trigger("manual")
  }

  /**
   * Is the scheduler currently running?
   */
  isRunning(): boolean {
    return this.running
  }

  /**
   * Is the scheduler paused?
   */
  isPaused(): boolean {
    return this.paused
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async checkIdle(): Promise<void> {
    if (this.paused) return
    if (!this.isInCooldown()) {
      const idleMs = this.activityTracker.getIdleMs()
      if (idleMs >= this.config.idleThresholdMs) {
        await this.trigger("idle")
      }
    }
  }

  private async cronTick(): Promise<void> {
    if (this.paused) return
    if (!this.isInCooldown()) {
      await this.trigger("cron")
    }
  }

  /**
   * Compute ms until the next occurrence of dailyAtHour (server-local time)
   * and arm a one-shot timer. After it fires, it re-arms itself for the
   * following day. Exposed via computeMsUntilNextDaily for testability.
   */
  private scheduleNextDaily(): void {
    const hour = this.config.dailyAtHour
    if (hour === undefined) return
    const delay = this.computeMsUntilNextDaily(hour, new Date())
    this.logger.info(
      "Next daily trigger in %s min (at %s:00 local)",
      Math.round(delay / 60000),
      hour,
    )
    this.dailyTimer = setTimeout(async () => {
      await this.cronTick()
      // Re-arm for the next day if still running.
      if (this.running) this.scheduleNextDaily()
    }, delay)
  }

  /**
   * Pure helper: ms from `now` until the next time the local clock reads
   * `hour:00:00`. If it's already past that hour today, returns the delay to
   * tomorrow's occurrence. Always returns a strictly positive value.
   */
  computeMsUntilNextDaily(hour: number, now: Date): number {
    const target = new Date(now)
    target.setHours(hour, 0, 0, 0)
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1)
    }
    return target.getTime() - now.getTime()
  }

  private async trigger(reason: SchedulerTriggerReason): Promise<boolean> {
    if (this.isInCooldown()) {
      this.logger.info("Trigger skipped (cooldown active)")
      return false
    }

    this.emit({ type: "trigger", reason, timestamp: Date.now() })
    this.logger.info("Triggering evolution: reason=%s", reason)

    try {
      const accepted = await this.onTrigger(reason)
      if (accepted) {
        this.lastTriggerAt = Date.now()
      }
      return accepted
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.warn("Trigger callback failed: %s", msg)
      return false
    }
  }

  private isInCooldown(): boolean {
    if (this.lastTriggerAt === 0) return false
    return Date.now() - this.lastTriggerAt < this.config.cooldownMs
  }

  private clearTimers(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.cronTimer) {
      clearInterval(this.cronTimer)
      this.cronTimer = null
    }
    if (this.dailyTimer) {
      clearTimeout(this.dailyTimer)
      this.dailyTimer = null
    }
  }

  private emit(event: SchedulerEvent): void {
    this.onEvent?.(event)
  }
}
