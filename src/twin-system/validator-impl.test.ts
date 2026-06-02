/**
 * Tests for ValidatorImpl and selectTraces.
 */
import { describe, it, expect, vi } from "vitest"
import {
  ValidatorImpl,
  selectTraces,
  DEFAULT_VALIDATOR_CONFIG,
  type CommandRunner,
  type ProcessSpawner,
  type ProcessHandle,
  type HealthChecker,
  type BehaviorTester,
  type TraceStore,
  type TraceRecord,
  type ValidatorConfig,
  type ValidatorLogger,
  type ValidatorImplDeps,
} from "./validator-impl.js"
import type { EvolutionIntent } from "./types.js"

// ── Test Helpers ─────────────────────────────────────────────────────────────

function makeIntent(overrides?: Partial<EvolutionIntent>): EvolutionIntent {
  return {
    id: "test-intent-v",
    type: "behavior_fix",
    description: "Fix response handling",
    targetFiles: ["src/handler.ts"],
    evidence: ["Error logs"],
    riskLevel: "low",
    requiresHumanApproval: false,
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeTrace(overrides?: Partial<TraceRecord>): TraceRecord {
  return {
    id: `trace-${Math.random().toString(36).slice(2, 8)}`,
    messageCount: 5,
    toolSequence: ["search", "read"],
    hadFailure: false,
    responseLength: 500,
    ...overrides,
  }
}

function makeDeps(overrides?: Partial<ValidatorImplDeps>): ValidatorImplDeps {
  const commandRunner: CommandRunner = {
    run: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "OK",
      stderr: "",
      timedOut: false,
    }),
  }

  const processHandle: ProcessHandle = {
    kill: vi.fn(),
    onExit: vi.fn(),
    exited: false,
  }

  const processSpawner: ProcessSpawner = {
    spawn: vi.fn().mockReturnValue(processHandle),
  }

  const healthChecker: HealthChecker = {
    waitForHealth: vi.fn().mockResolvedValue(true),
  }

  const behaviorTester: BehaviorTester = {
    testTrace: vi.fn().mockResolvedValue({
      traceId: "t1",
      statusCode: 200,
      responseLength: 400,
      responseToolSequence: ["search", "read"],
      toolSequenceMatch: true,
      lengthInRange: true,
      isError: false,
    }),
  }

  const config: ValidatorConfig = {
    ...DEFAULT_VALIDATOR_CONFIG,
    repoRoot: "/repo",
  }

  const logger: ValidatorLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  return {
    commandRunner,
    processSpawner,
    healthChecker,
    behaviorTester,
    config,
    logger,
    ...overrides,
  }
}

// ── selectTraces tests ───────────────────────────────────────────────────────

describe("selectTraces", () => {
  it("returns empty for no traces", () => {
    expect(selectTraces([])).toHaveLength(0)
  })

  it("selects up to 5 from a large pool", () => {
    const traces = Array.from({ length: 20 }, (_, i) =>
      makeTrace({
        id: `trace-${i}`,
        messageCount: i + 1,
        toolSequence: Array.from({ length: i % 5 }, () => "tool"),
        hadFailure: i === 7,
      }),
    )
    const selected = selectTraces(traces)
    expect(selected.length).toBeLessThanOrEqual(5)
    expect(selected.length).toBeGreaterThan(0)
  })

  it("includes failure traces when available", () => {
    const traces = [
      makeTrace({ id: "a", hadFailure: false, messageCount: 10 }),
      makeTrace({ id: "b", hadFailure: true, messageCount: 5 }),
      makeTrace({ id: "c", hadFailure: false, messageCount: 3 }),
    ]
    const selected = selectTraces(traces)
    const ids = selected.map((t) => t.id)
    expect(ids).toContain("b")
  })

  it("includes most-messages and fewest-messages traces", () => {
    const traces = [
      makeTrace({ id: "short", messageCount: 1, toolSequence: [] }),
      makeTrace({ id: "medium", messageCount: 5, toolSequence: ["a"] }),
      makeTrace({ id: "long", messageCount: 20, toolSequence: ["a", "b", "c"] }),
    ]
    const selected = selectTraces(traces)
    const ids = selected.map((t) => t.id)
    expect(ids).toContain("long")
    expect(ids).toContain("short")
  })

  it("deduplicates (same trace can match multiple criteria)", () => {
    // Single trace that is both shortest and longest
    const traces = [makeTrace({ id: "only", messageCount: 5 })]
    const selected = selectTraces(traces)
    expect(selected).toHaveLength(1)
    expect(selected[0].id).toBe("only")
  })
})

// ── ValidatorImpl Level 1 tests ──────────────────────────────────────────────

describe("ValidatorImpl - Level 1", () => {
  it("passes when build and test succeed", async () => {
    const deps = makeDeps()
    const validator = new ValidatorImpl(deps)
    const intent = makeIntent()

    const result = await validator.validate(intent)

    expect(result.level).toBe(1)
    expect(result.passed).toBe(true)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("fails when build fails", async () => {
    const deps = makeDeps({
      commandRunner: {
        run: vi.fn().mockResolvedValue({
          exitCode: 1,
          stdout: "",
          stderr: "tsc error: something wrong",
          timedOut: false,
        }),
      },
    })
    const validator = new ValidatorImpl(deps)

    const result = await validator.validate(makeIntent())

    expect(result.passed).toBe(false)
    expect(result.reason).toContain("pnpm build failed")
  })

  it("fails when build times out", async () => {
    const deps = makeDeps({
      commandRunner: {
        run: vi.fn().mockResolvedValue({
          exitCode: 1,
          stdout: "",
          stderr: "",
          timedOut: true,
        }),
      },
    })
    const validator = new ValidatorImpl(deps)

    const result = await validator.validate(makeIntent())

    expect(result.passed).toBe(false)
    expect(result.reason).toContain("timed out")
  })

  it("fails when test fails (build passes)", async () => {
    let callCount = 0
    const deps = makeDeps({
      commandRunner: {
        run: vi.fn().mockImplementation(async () => {
          callCount++
          if (callCount === 1) {
            // build succeeds
            return { exitCode: 0, stdout: "", stderr: "", timedOut: false }
          }
          // test fails
          return {
            exitCode: 1,
            stdout: "FAIL: 3 tests failed",
            stderr: "",
            timedOut: false,
          }
        }),
      },
    })
    const validator = new ValidatorImpl(deps)

    const result = await validator.validate(makeIntent())

    expect(result.passed).toBe(false)
    expect(result.reason).toContain("pnpm test failed")
    const details = JSON.parse(result.details)
    expect(details.buildPassed).toBe(true)
    expect(details.testsPassed).toBe(false)
  })
})

// ── ValidatorImpl Level 2 tests ──────────────────────────────────────────────

describe("ValidatorImpl - Level 2", () => {
  it("skips when no trace store provided", async () => {
    const deps = makeDeps({ traceStore: undefined })
    const validator = new ValidatorImpl(deps)

    const result = await validator.validateLevel2!(makeIntent())

    expect(result.level).toBe(2)
    expect(result.passed).toBe(true)
    expect(result.reason).toBe("no_trace_store")
  })

  it("skips when insufficient traces", async () => {
    const traceStore: TraceStore = {
      getRecentTraces: () => [makeTrace(), makeTrace()], // only 2, need 3
    }
    const deps = makeDeps({ traceStore })
    const validator = new ValidatorImpl(deps)

    const result = await validator.validateLevel2!(makeIntent())

    expect(result.passed).toBe(true)
    expect(result.reason).toBe("insufficient_traces")
  })

  it("fails when build fails in Level 2", async () => {
    const traceStore: TraceStore = {
      getRecentTraces: () => [makeTrace(), makeTrace(), makeTrace()],
    }
    const deps = makeDeps({
      traceStore,
      commandRunner: {
        run: vi.fn().mockResolvedValue({
          exitCode: 1,
          stdout: "",
          stderr: "build error",
          timedOut: false,
        }),
      },
    })
    const validator = new ValidatorImpl(deps)

    const result = await validator.validateLevel2!(makeIntent())

    expect(result.passed).toBe(false)
    expect(result.reason).toBe("startup_failed")
  })

  it("fails when health check times out", async () => {
    const traceStore: TraceStore = {
      getRecentTraces: () => [makeTrace(), makeTrace(), makeTrace()],
    }
    const deps = makeDeps({
      traceStore,
      healthChecker: { waitForHealth: vi.fn().mockResolvedValue(false) },
    })
    const validator = new ValidatorImpl(deps)

    const result = await validator.validateLevel2!(makeIntent())

    expect(result.passed).toBe(false)
    expect(result.reason).toBe("startup_failed")
  })

  it("fails when process exits prematurely", async () => {
    const traceStore: TraceStore = {
      getRecentTraces: () => [makeTrace(), makeTrace(), makeTrace()],
    }
    const exitedHandle: ProcessHandle = {
      kill: vi.fn(),
      onExit: vi.fn(),
      exited: true, // already exited
    }
    const deps = makeDeps({
      traceStore,
      processSpawner: { spawn: vi.fn().mockReturnValue(exitedHandle) },
      healthChecker: { waitForHealth: vi.fn().mockResolvedValue(true) },
    })
    const validator = new ValidatorImpl(deps)

    const result = await validator.validateLevel2!(makeIntent())

    expect(result.passed).toBe(false)
    expect(result.reason).toBe("startup_failed")
  })

  it("passes when all behavior tests pass", async () => {
    const traces = [makeTrace(), makeTrace(), makeTrace()]
    const traceStore: TraceStore = { getRecentTraces: () => traces }
    const deps = makeDeps({ traceStore })
    const validator = new ValidatorImpl(deps)

    const result = await validator.validateLevel2!(makeIntent())

    expect(result.passed).toBe(true)
    expect(result.level).toBe(2)
  })

  it("fails on high error rate", async () => {
    const traces = [makeTrace(), makeTrace(), makeTrace()]
    const traceStore: TraceStore = { getRecentTraces: () => traces }
    const deps = makeDeps({
      traceStore,
      behaviorTester: {
        testTrace: vi.fn().mockResolvedValue({
          traceId: "t1",
          statusCode: 500,
          responseLength: 0,
          responseToolSequence: [],
          toolSequenceMatch: false,
          lengthInRange: false,
          isError: true, // all errors
        }),
      },
    })
    const validator = new ValidatorImpl(deps)

    const result = await validator.validateLevel2!(makeIntent())

    expect(result.passed).toBe(false)
    expect(result.reason).toContain("high_error_rate")
  })

  it("fails on low length pass rate", async () => {
    const traces = [makeTrace(), makeTrace(), makeTrace()]
    const traceStore: TraceStore = { getRecentTraces: () => traces }
    const deps = makeDeps({
      traceStore,
      behaviorTester: {
        testTrace: vi.fn().mockResolvedValue({
          traceId: "t1",
          statusCode: 200,
          responseLength: 1,
          responseToolSequence: [],
          toolSequenceMatch: true,
          lengthInRange: false, // all fail length check
          isError: false,
        }),
      },
    })
    const validator = new ValidatorImpl(deps)

    const result = await validator.validateLevel2!(makeIntent())

    expect(result.passed).toBe(false)
    expect(result.reason).toContain("low_length_pass_rate")
  })

  it("kills the temporary process in finally block", async () => {
    const traces = [makeTrace(), makeTrace(), makeTrace()]
    const traceStore: TraceStore = { getRecentTraces: () => traces }
    const killFn = vi.fn()
    const procHandle: ProcessHandle = {
      kill: killFn,
      onExit: vi.fn(),
      exited: false,
    }
    const deps = makeDeps({
      traceStore,
      processSpawner: { spawn: vi.fn().mockReturnValue(procHandle) },
    })
    const validator = new ValidatorImpl(deps)

    await validator.validateLevel2!(makeIntent())

    expect(killFn).toHaveBeenCalledWith("SIGTERM")
  })

  it("does not kill process if already exited", async () => {
    const traces = [makeTrace(), makeTrace(), makeTrace()]
    const traceStore: TraceStore = { getRecentTraces: () => traces }
    const killFn = vi.fn()
    // Process will "exit" during the test
    let exitedState = false
    const procHandle: ProcessHandle = {
      kill: killFn,
      onExit: vi.fn(),
      get exited() { return exitedState },
    }
    const deps = makeDeps({
      traceStore,
      processSpawner: { spawn: vi.fn().mockReturnValue(procHandle) },
      behaviorTester: {
        testTrace: vi.fn().mockImplementation(async () => {
          exitedState = true // simulate process exit during testing
          return {
            traceId: "t1",
            statusCode: 200,
            responseLength: 400,
            responseToolSequence: [],
            toolSequenceMatch: true,
            lengthInRange: true,
            isError: false,
          }
        }),
      },
    })
    const validator = new ValidatorImpl(deps)

    await validator.validateLevel2!(makeIntent())

    expect(killFn).not.toHaveBeenCalled()
  })
})
