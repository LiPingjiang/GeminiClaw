/**
 * Tests for SchedulerRunner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  SchedulerRunner,
  type ActivityTracker,
  type SchedulerLogger,
  type SchedulerRunnerDeps,
  type SchedulerEvent,
  type TriggerCallback,
} from "./scheduler.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDeps(overrides?: Partial<SchedulerRunnerDeps>): SchedulerRunnerDeps {
  const activityTracker: ActivityTracker = {
    getIdleMs: vi.fn().mockReturnValue(10 * 60 * 1000), // 10 min idle by default
  }

  const onTrigger: TriggerCallback = vi.fn().mockResolvedValue(true)

  const logger: SchedulerLogger = {
    info: vi.fn(),
    warn: vi.fn(),
  }

  return {
    activityTracker,
    onTrigger,
    logger,
    config: {
      idleThresholdMs: 100, // very short for tests
      cronIntervalMs: 200,
      pollIntervalMs: 50,
      cooldownMs: 150,
      idleEnabled: true,
      cronEnabled: true,
    },
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SchedulerRunner", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("starts and stops without errors", () => {
    const deps = makeDeps()
    const scheduler = new SchedulerRunner(deps)

    scheduler.start()
    expect(scheduler.isRunning()).toBe(true)

    scheduler.stop()
    expect(scheduler.isRunning()).toBe(false)
  })

  it("triggers on idle detection", async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    const scheduler = new SchedulerRunner(deps)

    scheduler.start()

    // Advance past poll interval
    await vi.advanceTimersByTimeAsync(60)

    expect(deps.onTrigger).toHaveBeenCalledWith("idle")

    scheduler.stop()
    vi.useRealTimers()
  })

  it("triggers on cron interval", async () => {
    vi.useFakeTimers()
    const deps = makeDeps({
      activityTracker: { getIdleMs: vi.fn().mockReturnValue(0) }, // not idle
      config: {
        idleThresholdMs: 100,
        cronIntervalMs: 200,
        pollIntervalMs: 50,
        cooldownMs: 50, // short cooldown
        idleEnabled: false, // disable idle to isolate cron
        cronEnabled: true,
      },
    })
    const scheduler = new SchedulerRunner(deps)

    scheduler.start()

    // Advance past cron interval
    await vi.advanceTimersByTimeAsync(210)

    expect(deps.onTrigger).toHaveBeenCalledWith("cron")

    scheduler.stop()
    vi.useRealTimers()
  })

  it("respects cooldown between triggers", async () => {
    vi.useFakeTimers()
    const deps = makeDeps({
      config: {
        idleThresholdMs: 50,
        cronIntervalMs: 0,
        pollIntervalMs: 30,
        cooldownMs: 200, // long cooldown
        idleEnabled: true,
        cronEnabled: false,
      },
    })
    const scheduler = new SchedulerRunner(deps)

    scheduler.start()

    // First trigger
    await vi.advanceTimersByTimeAsync(40)
    expect(deps.onTrigger).toHaveBeenCalledTimes(1)

    // Second poll within cooldown
    await vi.advanceTimersByTimeAsync(40)
    expect(deps.onTrigger).toHaveBeenCalledTimes(1) // still 1

    scheduler.stop()
    vi.useRealTimers()
  })

  it("does not trigger when paused", async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    const scheduler = new SchedulerRunner(deps)

    scheduler.start()
    scheduler.pause()
    expect(scheduler.isPaused()).toBe(true)

    await vi.advanceTimersByTimeAsync(200)

    expect(deps.onTrigger).not.toHaveBeenCalled()

    scheduler.stop()
    vi.useRealTimers()
  })

  it("resumes triggering after unpause", async () => {
    vi.useFakeTimers()
    const deps = makeDeps({
      config: {
        idleThresholdMs: 50,
        cronIntervalMs: 0,
        pollIntervalMs: 30,
        cooldownMs: 10,
        idleEnabled: true,
        cronEnabled: false,
      },
    })
    const scheduler = new SchedulerRunner(deps)

    scheduler.start()
    scheduler.pause()

    await vi.advanceTimersByTimeAsync(100)
    expect(deps.onTrigger).not.toHaveBeenCalled()

    scheduler.resume()
    expect(scheduler.isPaused()).toBe(false)

    await vi.advanceTimersByTimeAsync(40)
    expect(deps.onTrigger).toHaveBeenCalledWith("idle")

    scheduler.stop()
    vi.useRealTimers()
  })

  it("manual trigger works", async () => {
    const deps = makeDeps()
    const scheduler = new SchedulerRunner(deps)

    const result = await scheduler.triggerManual()

    expect(result).toBe(true)
    expect(deps.onTrigger).toHaveBeenCalledWith("manual")
  })

  it("manual trigger respects cooldown", async () => {
    const deps = makeDeps({
      config: {
        idleThresholdMs: 50,
        cronIntervalMs: 0,
        pollIntervalMs: 30,
        cooldownMs: 10000, // very long cooldown
        idleEnabled: false,
        cronEnabled: false,
      },
    })
    const scheduler = new SchedulerRunner(deps)

    // First manual trigger succeeds
    const first = await scheduler.triggerManual()
    expect(first).toBe(true)

    // Second is in cooldown
    const second = await scheduler.triggerManual()
    expect(second).toBe(false)
  })

  it("emits events", async () => {
    const events: SchedulerEvent[] = []
    const deps = makeDeps({
      onEvent: (e) => events.push(e),
    })
    const scheduler = new SchedulerRunner(deps)

    scheduler.start()
    scheduler.pause()
    scheduler.resume()
    scheduler.stop()

    const types = events.map((e) => e.type)
    expect(types).toContain("started")
    expect(types).toContain("paused")
    expect(types).toContain("resumed")
    expect(types).toContain("stopped")
  })

  it("does not trigger when system is not idle", async () => {
    vi.useFakeTimers()
    const deps = makeDeps({
      activityTracker: { getIdleMs: vi.fn().mockReturnValue(10) }, // only 10ms idle
      config: {
        idleThresholdMs: 5000, // need 5s idle
        cronIntervalMs: 0,
        pollIntervalMs: 30,
        cooldownMs: 10,
        idleEnabled: true,
        cronEnabled: false,
      },
    })
    const scheduler = new SchedulerRunner(deps)

    scheduler.start()
    await vi.advanceTimersByTimeAsync(100)

    expect(deps.onTrigger).not.toHaveBeenCalled()

    scheduler.stop()
    vi.useRealTimers()
  })

  it("handles trigger callback failure", async () => {
    const deps = makeDeps({
      onTrigger: vi.fn().mockRejectedValue(new Error("pipeline busy")),
    })
    const scheduler = new SchedulerRunner(deps)

    const result = await scheduler.triggerManual()

    expect(result).toBe(false)
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "Trigger callback failed: %s",
      "pipeline busy",
    )
  })

  it("start is idempotent", () => {
    const deps = makeDeps()
    const scheduler = new SchedulerRunner(deps)

    scheduler.start()
    scheduler.start() // should not double-register timers

    expect(scheduler.isRunning()).toBe(true)
    scheduler.stop()
  })

  describe("daily-at-hour scheduling", () => {
    function makeScheduler() {
      return new SchedulerRunner(
        makeDeps({
          activityTracker: { getIdleMs: vi.fn().mockReturnValue(0) },
          config: {
            idleThresholdMs: 100,
            cronIntervalMs: 200,
            dailyAtHour: 3,
            pollIntervalMs: 50,
            cooldownMs: 50,
            idleEnabled: false,
            cronEnabled: true,
          },
        }),
      )
    }

    it("computes ms until the next occurrence later today", () => {
      const scheduler = makeScheduler()
      const now = new Date(2026, 5, 12, 1, 0, 0, 0) // 01:00 → 3:00 today
      const ms = scheduler.computeMsUntilNextDaily(3, now)
      expect(ms).toBe(2 * 60 * 60 * 1000)
    })

    it("rolls over to tomorrow when the hour already passed", () => {
      const scheduler = makeScheduler()
      const now = new Date(2026, 5, 12, 5, 0, 0, 0) // 05:00 → 3:00 tomorrow
      const ms = scheduler.computeMsUntilNextDaily(3, now)
      expect(ms).toBe(22 * 60 * 60 * 1000)
    })

    it("rolls over when exactly at the target hour boundary", () => {
      const scheduler = makeScheduler()
      const now = new Date(2026, 5, 12, 3, 0, 0, 0) // exactly 03:00 → tomorrow
      const ms = scheduler.computeMsUntilNextDaily(3, now)
      expect(ms).toBe(24 * 60 * 60 * 1000)
    })

    it("always returns a strictly positive delay", () => {
      const scheduler = makeScheduler()
      for (let h = 0; h < 24; h++) {
        const now = new Date(2026, 5, 12, h, 30, 0, 0)
        expect(scheduler.computeMsUntilNextDaily(3, now)).toBeGreaterThan(0)
      }
    })

    it("triggers via cron reason when the daily timer fires", async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 5, 12, 1, 0, 0, 0)) // 01:00 → fires at 03:00
      const deps = makeDeps({
        activityTracker: { getIdleMs: vi.fn().mockReturnValue(0) },
        config: {
          idleThresholdMs: 100,
          cronIntervalMs: 0,
          dailyAtHour: 3,
          pollIntervalMs: 50,
          cooldownMs: 50,
          idleEnabled: false,
          cronEnabled: true,
        },
      })
      const scheduler = new SchedulerRunner(deps)

      scheduler.start()
      expect(deps.onTrigger).not.toHaveBeenCalled()

      // Advance to 03:00 (2h later).
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 10)
      expect(deps.onTrigger).toHaveBeenCalledWith("cron")

      scheduler.stop()
      vi.useRealTimers()
    })

    it("re-arms for the next day after firing", async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 5, 12, 1, 0, 0, 0))
      const deps = makeDeps({
        activityTracker: { getIdleMs: vi.fn().mockReturnValue(0) },
        config: {
          idleThresholdMs: 100,
          cronIntervalMs: 0,
          dailyAtHour: 3,
          pollIntervalMs: 50,
          cooldownMs: 50,
          idleEnabled: false,
          cronEnabled: true,
        },
      })
      const scheduler = new SchedulerRunner(deps)

      scheduler.start()
      // Day 1 at 03:00
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 10)
      expect(deps.onTrigger).toHaveBeenCalledTimes(1)

      // Day 2 at 03:00 (24h later)
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
      expect(deps.onTrigger).toHaveBeenCalledTimes(2)

      scheduler.stop()
      vi.useRealTimers()
    })

    it("does not start the fixed cron interval when dailyAtHour is set", async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 5, 12, 12, 0, 0, 0)) // far from 03:00
      const deps = makeDeps({
        activityTracker: { getIdleMs: vi.fn().mockReturnValue(0) },
        config: {
          idleThresholdMs: 100,
          cronIntervalMs: 200, // would fire quickly if interval mode were used
          dailyAtHour: 3,
          pollIntervalMs: 50,
          cooldownMs: 50,
          idleEnabled: false,
          cronEnabled: true,
        },
      })
      const scheduler = new SchedulerRunner(deps)

      scheduler.start()
      // Far more than cronIntervalMs, but nowhere near 03:00.
      await vi.advanceTimersByTimeAsync(5000)
      expect(deps.onTrigger).not.toHaveBeenCalled()

      scheduler.stop()
      vi.useRealTimers()
    })
  })
})
