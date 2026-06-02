/**
 * Tests for PostSwitchMonitor.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  PostSwitchMonitor,
  type HealthProbe,
  type ErrorCounter,
  type MonitorLogger,
  type PostSwitchMonitorDeps,
  type MonitorEvent,
} from "./post-switch-monitor.js"
import type { EvolutionRecord } from "./types.js"
import type { SlotManager } from "./slot-manager.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSwitchRecord(): EvolutionRecord {
  return {
    id: "evo_001",
    intentId: "intent-123",
    action: "switch",
    success: true,
    fromSlot: "b",
    toSlot: "a",
    changedFiles: ["src/foo.ts"],
    timestamp: Date.now(),
  }
}

function makeDeps(overrides?: Partial<PostSwitchMonitorDeps>): PostSwitchMonitorDeps {
  const healthProbe: HealthProbe = {
    check: vi.fn().mockResolvedValue(true),
  }

  const errorCounter: ErrorCounter = {
    getTotalRequests: vi.fn().mockReturnValue(100),
    getErrorCount: vi.fn().mockReturnValue(2),
  }

  const slotManager = {
    rollback: vi.fn(),
  } as unknown as SlotManager

  const logger: MonitorLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  return {
    healthProbe,
    errorCounter,
    slotManager,
    logger,
    config: {
      monitorWindowMs: 200, // very short for tests
      healthCheckIntervalMs: 50,
      errorRateCheckIntervalMs: 80,
      failureRateThreshold: 0.1,
      minRequestsForRateCheck: 10,
      maxConsecutiveHealthFailures: 3,
    },
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PostSwitchMonitor", () => {
  it("completes successfully when service is healthy", async () => {
    const deps = makeDeps()
    const monitor = new PostSwitchMonitor(deps)

    const result = await monitor.monitor(makeSwitchRecord())

    expect(result.passed).toBe(true)
    expect(result.rolledBack).toBe(false)
    expect(result.durationMs).toBeGreaterThanOrEqual(150) // ~monitorWindowMs
    expect(result.healthChecks).toBeGreaterThan(0)
    expect(result.healthFailures).toBe(0)
  })

  it("triggers rollback on consecutive health failures", async () => {
    const deps = makeDeps({
      healthProbe: {
        check: vi.fn().mockResolvedValue(false), // always unhealthy
      },
    })
    const monitor = new PostSwitchMonitor(deps)

    const result = await monitor.monitor(makeSwitchRecord())

    expect(result.passed).toBe(false)
    expect(result.rolledBack).toBe(true)
    expect(result.rollbackReason).toContain("consecutive health check failures")
    expect((deps.slotManager as any).rollback).toHaveBeenCalled()
  })

  it("triggers rollback on high error rate", async () => {
    const deps = makeDeps({
      errorCounter: {
        getTotalRequests: vi.fn().mockReturnValue(100),
        getErrorCount: vi.fn().mockReturnValue(50), // 50% error rate
      },
    })
    const monitor = new PostSwitchMonitor(deps)

    const result = await monitor.monitor(makeSwitchRecord())

    expect(result.passed).toBe(false)
    expect(result.rolledBack).toBe(true)
    expect(result.rollbackReason).toContain("exceeds threshold")
  })

  it("does not check error rate with insufficient requests", async () => {
    const deps = makeDeps({
      errorCounter: {
        getTotalRequests: vi.fn().mockReturnValue(5), // below minRequestsForRateCheck (10)
        getErrorCount: vi.fn().mockReturnValue(5), // 100% error rate but too few requests
      },
    })
    const monitor = new PostSwitchMonitor(deps)

    const result = await monitor.monitor(makeSwitchRecord())

    // Should pass because insufficient requests means error rate check is skipped
    expect(result.passed).toBe(true)
  })

  it("recovers from intermittent health failures", async () => {
    let callCount = 0
    const deps = makeDeps({
      healthProbe: {
        check: vi.fn().mockImplementation(async () => {
          callCount++
          // Fail twice, then succeed (never hits 3 consecutive)
          return callCount % 3 !== 0
        }),
      },
    })
    const monitor = new PostSwitchMonitor(deps)

    const result = await monitor.monitor(makeSwitchRecord())

    expect(result.passed).toBe(true)
    expect(result.healthFailures).toBeGreaterThan(0)
  })

  it("can be aborted early", async () => {
    const deps = makeDeps({
      config: {
        monitorWindowMs: 5000, // long window
        healthCheckIntervalMs: 50,
        errorRateCheckIntervalMs: 100,
        failureRateThreshold: 0.1,
        minRequestsForRateCheck: 10,
        maxConsecutiveHealthFailures: 3,
      },
    })
    const monitor = new PostSwitchMonitor(deps)

    // Abort after 100ms
    setTimeout(() => monitor.abort(), 100)

    const result = await monitor.monitor(makeSwitchRecord())

    expect(result.passed).toBe(true)
    expect(result.durationMs).toBeLessThan(5000)
  })

  it("emits events during monitoring", async () => {
    const events: MonitorEvent[] = []
    const deps = makeDeps({
      onEvent: (e) => events.push(e),
    })
    const monitor = new PostSwitchMonitor(deps)

    await monitor.monitor(makeSwitchRecord())

    const types = events.map((e) => e.type)
    expect(types).toContain("monitoring_started")
    expect(types).toContain("health_check")
    expect(types).toContain("monitoring_completed")
  })

  it("handles rollback failure gracefully", async () => {
    const deps = makeDeps({
      healthProbe: { check: vi.fn().mockResolvedValue(false) },
    })
    ;(deps.slotManager as any).rollback = vi.fn().mockImplementation(() => {
      throw new Error("git lock")
    })
    const monitor = new PostSwitchMonitor(deps)

    const result = await monitor.monitor(makeSwitchRecord())

    expect(result.rolledBack).toBe(true)
    expect(deps.logger.error).toHaveBeenCalledWith(
      "Rollback failed: %s",
      "git lock",
    )
  })
})
