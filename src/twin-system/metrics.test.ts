/**
 * Tests for EvolutionMetrics — observability collector for the twin-system.
 */
import { describe, it, expect, beforeEach } from "vitest"
import { EvolutionMetrics } from "./metrics.js"

describe("EvolutionMetrics", () => {
  let metrics: EvolutionMetrics

  beforeEach(() => {
    metrics = new EvolutionMetrics({ maxCyclesPerDay: 5, recentHistorySize: 3 })
  })

  it("starts with zero counters", () => {
    const snap = metrics.snapshot()
    expect(snap.totalCycles).toBe(0)
    expect(snap.successCount).toBe(0)
    expect(snap.failureCount).toBe(0)
    expect(snap.skippedCount).toBe(0)
    expect(snap.rollbackCount).toBe(0)
    expect(snap.cyclesToday).toBe(0)
    expect(snap.lastCycleAt).toBeNull()
    expect(snap.recentCycles).toEqual([])
  })

  it("records successful cycles", () => {
    const now = Date.now()
    metrics.recordCycle({
      intentId: "i1",
      intentType: "behavior_fix",
      trigger: "cron",
      startedAt: now - 1000,
      success: true,
      changedFiles: ["a.ts", "b.ts"],
      rolled_back: false,
    })

    const snap = metrics.snapshot()
    expect(snap.totalCycles).toBe(1)
    expect(snap.successCount).toBe(1)
    expect(snap.failureCount).toBe(0)
    expect(snap.cyclesToday).toBe(1)
    expect(snap.lastCycleAt).not.toBeNull()
    expect(snap.recentCycles).toHaveLength(1)
    expect(snap.recentCycles[0].durationMs).toBeGreaterThanOrEqual(1000)
    expect(snap.recentCycles[0].changedFiles).toEqual(["a.ts", "b.ts"])
  })

  it("records failed cycles", () => {
    metrics.recordCycle({
      intentId: "i2",
      intentType: "optimization",
      trigger: "idle",
      startedAt: Date.now() - 500,
      success: false,
      abortReason: "Validation failed",
      changedFiles: [],
      rolled_back: false,
    })

    const snap = metrics.snapshot()
    expect(snap.totalCycles).toBe(1)
    expect(snap.successCount).toBe(0)
    expect(snap.failureCount).toBe(1)
  })

  it("records skipped triggers", () => {
    metrics.recordSkipped()
    metrics.recordSkipped()
    expect(metrics.snapshot().skippedCount).toBe(2)
  })

  it("records rollbacks", () => {
    metrics.recordRollback()
    expect(metrics.snapshot().rollbackCount).toBe(1)
  })

  it("enforces daily budget via canRunToday()", () => {
    expect(metrics.canRunToday()).toBe(true)
    expect(metrics.remainingToday()).toBe(5)

    for (let i = 0; i < 5; i++) {
      metrics.recordCycle({
        intentId: `i${i}`,
        intentType: "behavior_fix",
        trigger: "cron",
        startedAt: Date.now() - 100,
        success: true,
        changedFiles: [],
        rolled_back: false,
      })
    }

    expect(metrics.canRunToday()).toBe(false)
    expect(metrics.remainingToday()).toBe(0)
  })

  it("unlimited budget when maxCyclesPerDay = 0", () => {
    const unlimited = new EvolutionMetrics({ maxCyclesPerDay: 0 })
    for (let i = 0; i < 100; i++) {
      unlimited.recordCycle({
        intentId: `i${i}`,
        intentType: "optimization",
        trigger: "cron",
        startedAt: Date.now() - 10,
        success: true,
        changedFiles: [],
        rolled_back: false,
      })
    }
    expect(unlimited.canRunToday()).toBe(true)
    expect(unlimited.remainingToday()).toBeNull()
  })

  it("trims recent history to configured size", () => {
    for (let i = 0; i < 10; i++) {
      metrics.recordCycle({
        intentId: `i${i}`,
        intentType: "behavior_fix",
        trigger: "manual",
        startedAt: Date.now() - 100,
        success: i % 2 === 0,
        changedFiles: [],
        rolled_back: false,
      })
    }

    // recentHistorySize = 3
    expect(metrics.snapshot().recentCycles).toHaveLength(3)
    // Most recent should be last
    expect(metrics.snapshot().recentCycles[2].intentId).toBe("i9")
  })

  it("computes avgDurationMs and p95DurationMs", () => {
    const durations = [100, 200, 300, 400, 500]
    durations.forEach((d, i) => {
      const start = Date.now() - d
      metrics.recordCycle({
        intentId: `i${i}`,
        intentType: "optimization",
        trigger: "cron",
        startedAt: start,
        finishedAt: start + d,
        success: true,
        changedFiles: [],
        rolled_back: false,
      })
    })

    const snap = metrics.snapshot()
    // Only last 3 due to recentHistorySize=3: [300, 400, 500]
    expect(snap.avgDurationMs).toBe(400)
    expect(snap.p95DurationMs).toBe(500)
  })

  it("reports uptime", () => {
    const snap = metrics.snapshot()
    expect(snap.uptimeSeconds).toBeGreaterThanOrEqual(0)
    expect(snap.uptimeSeconds).toBeLessThan(5) // test runs in <5s
  })

  it("reset clears everything", () => {
    metrics.recordCycle({
      intentId: "x",
      intentType: "behavior_fix",
      trigger: "cron",
      startedAt: Date.now() - 100,
      success: true,
      changedFiles: ["z.ts"],
      rolled_back: false,
    })
    metrics.recordSkipped()
    metrics.recordRollback()

    metrics.reset()
    const snap = metrics.snapshot()
    expect(snap.totalCycles).toBe(0)
    expect(snap.skippedCount).toBe(0)
    expect(snap.rollbackCount).toBe(0)
    expect(snap.recentCycles).toEqual([])
  })
})
