/**
 * SchedulerRunner — Unified scheduler for the evolution engine.
 *
 * Determines WHEN to trigger evolution cycles:
 * 1. Idle detection: trigger when system has been idle for X seconds
 * 2. Cron-based: trigger on a regular interval (e.g., every 30 min)
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

    this.emit({ type: "started", timestamp: Date.now() })
    this.logger.info("Scheduler started (idle=%s, cron=%s)", this.config.idleEnabled, this.config.cronEnabled)

    // Idle polling
    if (this.config.idleEnabled) {
      this.pollTimer = setInterval(
        () => this.checkIdle(),
        this.config.pollIntervalMs,
      )
    }

    // Cron interval
    if (this.config.cronEnabled && this.config.cronIntervalMs > 0) {
      this.cronTimer = setInterval(
        () => this.cronTick(),
        this.config.cronIntervalMs,
      )
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
  }

  private emit(event: SchedulerEvent): void {
    this.onEvent?.(event)
  }
}
