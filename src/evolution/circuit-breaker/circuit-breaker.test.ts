// src/evolution/circuit-breaker/circuit-breaker.test.ts
// Unit tests for CircuitBreaker.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { CircuitBreaker, PROTECTED_PATHS } from "./circuit-breaker.js"
import type { EvolutionDB } from "../db.js"
import type { Switcher } from "../switcher/switcher.js"
import type { EvolutionConfig } from "../types.js"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

function makeMockDb(failureRate = 0): Partial<EvolutionDB> {
  return {
    getFailureRate: vi.fn().mockReturnValue(failureRate),
    getEvolutionCountForFile: vi.fn().mockReturnValue(0),
    insertEvolutionRecord: vi.fn(),
  }
}

function makeMockSwitcher(rollbackSuccess = true): Partial<Switcher> {
  return {
    rollback: vi.fn().mockResolvedValue({
      success: rollbackSuccess,
      fromSlot: "a" as const,
      toSlot: "b" as const,
    }),
  }
}

const mockConfig: EvolutionConfig["circuitBreaker"] = {
  errorRateThreshold: 0.2,
  responseTimeMultiplier: 2.0,
  maxEvolutionsPerFile24h: 3,
  failureThreshold: 0.5,
  monitoringWindowMs: 500,   // short for tests
  checkIntervalMs: 100,      // short for tests
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("creates a CircuitBreaker instance", () => {
    const cb = new CircuitBreaker({
      db: makeMockDb() as EvolutionDB,
      switcher: makeMockSwitcher() as Switcher,
      config: mockConfig,
      logger: mockLogger,
    })
    expect(cb).toBeDefined()
  })

  it("initial state is closed (not open)", () => {
    const cb = new CircuitBreaker({
      db: makeMockDb() as EvolutionDB,
      switcher: makeMockSwitcher() as Switcher,
      config: mockConfig,
      logger: mockLogger,
    })
    const state = cb.getState()
    expect(state.isOpen).toBe(false)
  })

  // -------------------------------------------------------------------------
  // canEvolve: circuit open
  // -------------------------------------------------------------------------

  it("canEvolve returns allowed=false when circuit is open", async () => {
    const db = makeMockDb(0.9)  // high failure rate
    const switcher = makeMockSwitcher()
    const cb = new CircuitBreaker({
      db: db as EvolutionDB,
      switcher: switcher as Switcher,
      config: mockConfig,
      logger: mockLogger,
    })

    // Start monitoring and advance timers to trigger health check + rollback
    cb.startMonitoring("intent-1")
    await vi.runAllTimersAsync()

    const state = cb.getState()
    expect(state.isOpen).toBe(true)

    const result = cb.canEvolve(["src/server/index.ts"])
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("circuit_open")
  })

  // -------------------------------------------------------------------------
  // canEvolve: protected paths
  // -------------------------------------------------------------------------

  it("canEvolve returns allowed=false for protected path src/evolution/", () => {
    const cb = new CircuitBreaker({
      db: makeMockDb() as EvolutionDB,
      switcher: makeMockSwitcher() as Switcher,
      config: mockConfig,
      logger: mockLogger,
    })

    const result = cb.canEvolve(["src/evolution/index.ts"])
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("protected_path")
  })

  it("canEvolve returns allowed=false for protected path src/config/", () => {
    const cb = new CircuitBreaker({
      db: makeMockDb() as EvolutionDB,
      switcher: makeMockSwitcher() as Switcher,
      config: mockConfig,
      logger: mockLogger,
    })

    const result = cb.canEvolve(["src/config/schema.ts"])
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("protected_path")
  })

  it("canEvolve returns allowed=false for protected path .gemini-data/", () => {
    const cb = new CircuitBreaker({
      db: makeMockDb() as EvolutionDB,
      switcher: makeMockSwitcher() as Switcher,
      config: mockConfig,
      logger: mockLogger,
    })

    const result = cb.canEvolve([".gemini-data/gemini.db"])
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("protected_path")
  })

  it("canEvolve returns allowed=true for non-protected paths", () => {
    const cb = new CircuitBreaker({
      db: makeMockDb() as EvolutionDB,
      switcher: makeMockSwitcher() as Switcher,
      config: mockConfig,
      logger: mockLogger,
    })

    const result = cb.canEvolve(["src/server/routes/chat.ts", "src/providers/router.ts"])
    expect(result.allowed).toBe(true)
  })

  // -------------------------------------------------------------------------
  // canEvolve: frequency limit
  // -------------------------------------------------------------------------

  it("canEvolve returns allowed=false when file evolution frequency limit exceeded", () => {
    const db = makeMockDb()
    ;(db.getEvolutionCountForFile as ReturnType<typeof vi.fn>).mockReturnValue(3)

    const cb = new CircuitBreaker({
      db: db as EvolutionDB,
      switcher: makeMockSwitcher() as Switcher,
      config: mockConfig,
      logger: mockLogger,
    })

    const result = cb.canEvolve(["src/server/routes/chat.ts"])
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("evolution_frequency_limit")
  })

  it("canEvolve returns allowed=true when file evolution count is below limit", () => {
    const db = makeMockDb()
    ;(db.getEvolutionCountForFile as ReturnType<typeof vi.fn>).mockReturnValue(2)

    const cb = new CircuitBreaker({
      db: db as EvolutionDB,
      switcher: makeMockSwitcher() as Switcher,
      config: mockConfig,
      logger: mockLogger,
    })

    const result = cb.canEvolve(["src/server/routes/chat.ts"])
    expect(result.allowed).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Monitoring: rollback on high failure rate
  // -------------------------------------------------------------------------

  it("triggers rollback when failure rate exceeds threshold", async () => {
    const db = makeMockDb(0.8)  // 80% failure rate > 0.5 threshold
    const switcher = makeMockSwitcher()
    const cb = new CircuitBreaker({
      db: db as EvolutionDB,
      switcher: switcher as Switcher,
      config: mockConfig,
      logger: mockLogger,
    })

    cb.startMonitoring("intent-rollback-test")

    // Advance past one check interval
    await vi.advanceTimersByTimeAsync(mockConfig.checkIntervalMs + 10)

    expect(switcher.rollback).toHaveBeenCalledOnce()
    expect(db.insertEvolutionRecord).toHaveBeenCalledWith(
      expect.objectContaining({ type: "rollback" })
    )

    const state = cb.getState()
    expect(state.isOpen).toBe(true)
    expect(state.openReason).toContain("high_failure_rate")
  })

  it("does not trigger rollback when failure rate is below threshold", async () => {
    const db = makeMockDb(0.1)  // 10% failure rate < 0.5 threshold
    const switcher = makeMockSwitcher()
    const cb = new CircuitBreaker({
      db: db as EvolutionDB,
      switcher: switcher as Switcher,
      config: mockConfig,
      logger: mockLogger,
    })

    cb.startMonitoring("intent-no-rollback")

    await vi.advanceTimersByTimeAsync(mockConfig.checkIntervalMs + 10)

    expect(switcher.rollback).not.toHaveBeenCalled()
    const state = cb.getState()
    expect(state.isOpen).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Monitoring: window expiry
  // -------------------------------------------------------------------------

  it("stops monitoring after monitoring window expires", async () => {
    const db = makeMockDb(0.0)  // no failures
    const switcher = makeMockSwitcher()
    const cb = new CircuitBreaker({
      db: db as EvolutionDB,
      switcher: switcher as Switcher,
      config: mockConfig,
      logger: mockLogger,
    })

    cb.startMonitoring("intent-window-test")
    expect(cb.getState().monitoringIntentId).toBe("intent-window-test")

    // Advance past the monitoring window
    await vi.advanceTimersByTimeAsync(mockConfig.monitoringWindowMs + 50)

    const state = cb.getState()
    expect(state.monitoringIntentId).toBeUndefined()
    expect(state.isOpen).toBe(false)
  })

  // -------------------------------------------------------------------------
  // stopMonitoring
  // -------------------------------------------------------------------------

  it("stopMonitoring clears monitoring state", () => {
    const cb = new CircuitBreaker({
      db: makeMockDb() as EvolutionDB,
      switcher: makeMockSwitcher() as Switcher,
      config: mockConfig,
      logger: mockLogger,
    })

    cb.startMonitoring("intent-stop-test")
    expect(cb.getState().monitoringIntentId).toBe("intent-stop-test")

    cb.stopMonitoring()
    expect(cb.getState().monitoringIntentId).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // PROTECTED_PATHS export
  // -------------------------------------------------------------------------

  it("PROTECTED_PATHS includes expected entries", () => {
    expect(PROTECTED_PATHS).toContain("src/evolution/")
    expect(PROTECTED_PATHS).toContain("src/config/")
    expect(PROTECTED_PATHS).toContain(".gemini-data/")
  })
})
