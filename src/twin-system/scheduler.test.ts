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
})
