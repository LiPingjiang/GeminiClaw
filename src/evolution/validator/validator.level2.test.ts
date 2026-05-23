// src/evolution/validator/validator.level2.test.ts
// Unit tests for Validator Level 2 (structural behavior assertions).
// Uses mocks for child_process.spawn and fetch to avoid real process startup.

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Intent, TraceRecord } from "../types.js"
import type { EvolutionDB } from "../db.js"

// ---------------------------------------------------------------------------
// Mock child_process.spawn BEFORE importing Validator
// ---------------------------------------------------------------------------

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>()
  return {
    ...actual,
    spawn: vi.fn(),
  }
})

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// ---------------------------------------------------------------------------
// Import AFTER mocks are set up
// ---------------------------------------------------------------------------

import { Validator } from "./validator.js"
import { spawn } from "child_process"
import { EventEmitter } from "events"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    id: "test-intent-level2",
    type: "behavior_fix",
    description: "Test Level 2 intent",
    targetFiles: ["src/server/routes/chat.ts"],
    evidence: [],
    riskLevel: "low",
    status: "validating",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeTrace(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: `trace-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: "session-1",
    toolSequence: [],
    hadFailure: false,
    messageCount: 5,
    responseLength: 200,
    recordedAt: Date.now(),
    ...overrides,
  }
}

function makeMockDb(traces: TraceRecord[]): Partial<EvolutionDB> {
  return {
    getRecentTraces: vi.fn().mockReturnValue(traces),
  }
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

const mockConfig = {
  level: 1 as const,
  standbyPort: 18889,
  testPort: 19889,
  diffThreshold: 0.3,
}

// ---------------------------------------------------------------------------
// Mock a successful spawn (build passes, process starts)
// ---------------------------------------------------------------------------

function mockSpawnBuildSuccess(): void {
  const spawnMock = vi.mocked(spawn)
  spawnMock.mockImplementation((_cmd: string, args: readonly string[]) => {
    const proc = new EventEmitter() as ReturnType<typeof spawn>
    const stdout = new EventEmitter() as NodeJS.ReadableStream
    const stderr = new EventEmitter() as NodeJS.ReadableStream
    ;(proc as unknown as Record<string, unknown>).stdout = stdout
    ;(proc as unknown as Record<string, unknown>).stderr = stderr
    ;(proc as unknown as Record<string, unknown>).kill = vi.fn()

    // pnpm build → succeed immediately
    if (args[0] === "build") {
      setTimeout(() => proc.emit("close", 0), 5)
    } else {
      // node dist/index.js → stay alive (server process)
      // Never emit close — it stays alive until killed
    }

    return proc
  })
}

function mockSpawnBuildFail(): void {
  const spawnMock = vi.mocked(spawn)
  spawnMock.mockImplementation((_cmd: string, args: readonly string[]) => {
    const proc = new EventEmitter() as ReturnType<typeof spawn>
    const stdout = new EventEmitter() as NodeJS.ReadableStream
    const stderr = new EventEmitter() as NodeJS.ReadableStream
    ;(proc as unknown as Record<string, unknown>).stdout = stdout
    ;(proc as unknown as Record<string, unknown>).stderr = stderr
    ;(proc as unknown as Record<string, unknown>).kill = vi.fn()

    if (args[0] === "build") {
      setTimeout(() => proc.emit("close", 1), 5)
    }

    return proc
  })
}

// ---------------------------------------------------------------------------
// Mock fetch for health check and chat requests
// ---------------------------------------------------------------------------

function mockFetchHealthyAndOkChat(responseLength = 200): void {
  mockFetch.mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("/v1/health")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: "ok" }),
      })
    }
    // Chat endpoint
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ content: "x".repeat(responseLength) }),
    })
  })
}

function mockFetchHealthyButErrorChat(): void {
  mockFetch.mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("/v1/health")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: "ok" }),
      })
    }
    // Chat endpoint returns 500
    return Promise.resolve({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "internal error" }),
    })
  })
}

function mockFetchHealthTimeout(): void {
  mockFetch.mockImplementation(() => {
    return Promise.reject(new Error("fetch timeout"))
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Validator Level 2", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Insufficient traces → skip
  // -------------------------------------------------------------------------

  it("skips Level 2 when fewer than 3 traces", async () => {
    const db = makeMockDb([makeTrace(), makeTrace()])  // only 2 traces

    const validator = new Validator({
      repoRoot: "/tmp/test",
      config: mockConfig,
      logger: mockLogger,
      db: db as EvolutionDB,
    })

    const result = await validator.validateLevel2(makeIntent())

    expect(result.level).toBe(2)
    expect(result.passed).toBe(true)
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe("insufficient_traces")
  })

  it("skips Level 2 when no DB provided", async () => {
    const validator = new Validator({
      repoRoot: "/tmp/test",
      config: mockConfig,
      logger: mockLogger,
      // no db
    })

    const result = await validator.validateLevel2(makeIntent())

    expect(result.level).toBe(2)
    expect(result.passed).toBe(true)
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe("no_db")
  })

  // -------------------------------------------------------------------------
  // Build failure → startup_failed
  // -------------------------------------------------------------------------

  it("returns startup_failed when pnpm build fails", async () => {
    const traces = Array.from({ length: 5 }, () => makeTrace())
    const db = makeMockDb(traces)

    mockSpawnBuildFail()

    const validator = new Validator({
      repoRoot: "/tmp/test",
      config: mockConfig,
      logger: mockLogger,
      db: db as EvolutionDB,
    })

    const result = await validator.validateLevel2(makeIntent())

    expect(result.level).toBe(2)
    expect(result.passed).toBe(false)
    expect(result.reason).toBe("startup_failed")
  })

  // -------------------------------------------------------------------------
  // Health check timeout → startup_failed
  // -------------------------------------------------------------------------

  it("returns startup_failed when health check times out", async () => {
    const traces = Array.from({ length: 5 }, () => makeTrace())
    const db = makeMockDb(traces)

    mockSpawnBuildSuccess()
    mockFetchHealthTimeout()

    // Use a very short timeout config for this test
    const shortConfig = {
      ...mockConfig,
      testPort: 19889,
    }

    const validator = new Validator({
      repoRoot: "/tmp/test",
      config: shortConfig,
      logger: mockLogger,
      db: db as EvolutionDB,
    })

    // We need to shorten the health wait — we do this by mocking AbortSignal.timeout
    // The actual implementation polls for 30s; since we mock fetch to always reject,
    // it will exhaust the deadline. We'll use a very small timeout by patching Date.now.
    const originalDateNow = Date.now
    let callCount = 0
    vi.spyOn(Date, "now").mockImplementation(() => {
      callCount++
      // After 5 calls, pretend we're past the 30s deadline
      if (callCount > 5) return originalDateNow() + 31_000
      return originalDateNow()
    })

    try {
      const result = await validator.validateLevel2(makeIntent())
      expect(result.level).toBe(2)
      expect(result.passed).toBe(false)
      expect(result.reason).toBe("startup_failed")
    } finally {
      vi.restoreAllMocks()
    }
  })

  // -------------------------------------------------------------------------
  // All requests succeed → Level 2 passes
  // -------------------------------------------------------------------------

  it("passes Level 2 when all requests succeed with reasonable response length", async () => {
    const traces = Array.from({ length: 5 }, () => makeTrace({ messageCount: 2 }))
    const db = makeMockDb(traces)

    mockSpawnBuildSuccess()
    mockFetchHealthyAndOkChat(200)  // 200 chars, original estimate ~200

    const validator = new Validator({
      repoRoot: "/tmp/test",
      config: mockConfig,
      logger: mockLogger,
      db: db as EvolutionDB,
    })

    const result = await validator.validateLevel2(makeIntent())

    expect(result.level).toBe(2)
    expect(result.passed).toBe(true)
    expect(result.skipped).toBeFalsy()
    expect(result.behaviorCheck).toBeDefined()
    expect(result.behaviorCheck!.errorRate).toBe(0)
    expect(result.behaviorCheck!.lengthCheckPassRate).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // High error rate → Level 2 fails
  // -------------------------------------------------------------------------

  it("fails Level 2 when error rate exceeds 0.3", async () => {
    const traces = Array.from({ length: 5 }, () => makeTrace())
    const db = makeMockDb(traces)

    mockSpawnBuildSuccess()
    mockFetchHealthyButErrorChat()  // All chat requests return 500

    const validator = new Validator({
      repoRoot: "/tmp/test",
      config: mockConfig,
      logger: mockLogger,
      db: db as EvolutionDB,
    })

    const result = await validator.validateLevel2(makeIntent())

    expect(result.level).toBe(2)
    expect(result.passed).toBe(false)
    expect(result.reason).toContain("high_error_rate")
    expect(result.behaviorCheck).toBeDefined()
    expect(result.behaviorCheck!.errorRate).toBeGreaterThan(0.3)
  })

  // -------------------------------------------------------------------------
  // ValidationResult structure
  // -------------------------------------------------------------------------

  it("returns a properly structured ValidationResult", async () => {
    const traces = Array.from({ length: 5 }, () => makeTrace())
    const db = makeMockDb(traces)

    mockSpawnBuildSuccess()
    mockFetchHealthyAndOkChat()

    const validator = new Validator({
      repoRoot: "/tmp/test",
      config: mockConfig,
      logger: mockLogger,
      db: db as EvolutionDB,
    })

    const result = await validator.validateLevel2(makeIntent())

    expect(result).toMatchObject({
      level: 2,
      passed: expect.any(Boolean),
      details: expect.any(String),
      durationMs: expect.any(Number),
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)

    // details should be valid JSON
    expect(() => JSON.parse(result.details)).not.toThrow()
  })
})
