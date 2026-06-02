/**
 * E2E Smoke Test — End-to-end evolution cycle.
 *
 * Tests the full pipeline integration with mocked external dependencies:
 *   Intent → SafetyGuard → SlotManager → MutatorImpl → ValidatorImpl → Switch → Monitor
 *
 * This validates that all components wire together correctly through
 * the EvolutionPipeline orchestrator.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { EvolutionPipeline } from "./evolution-pipeline.js"
import { MutatorImpl } from "./mutator-impl.js"
import type {
  FileSystem,
  TypeChecker,
  GitOps as MutatorGitOps,
  LlmClient,
  MutatorConfig,
  FuzzyMatcher,
} from "./mutator-impl.js"
import { ValidatorImpl } from "./validator-impl.js"
import type {
  CommandRunner,
  CommandResult,
  ProcessSpawner,
  ProcessHandle,
  HealthChecker,
  BehaviorTester,
  TraceStore,
  ValidatorConfig,
} from "./validator-impl.js"
import { SafetyGuard } from "./safety-guard.js"
import { SlotManager, type GitOps as SlotGitOps } from "./slot-manager.js"
import { IntentAggregator, type IntentSource } from "./intent-aggregator.js"
import { PostSwitchMonitor } from "./post-switch-monitor.js"
import type { HealthProbe, ErrorCounter } from "./post-switch-monitor.js"
import { PersistenceAdapter, type SqliteDb, type SqliteStatement } from "./persistence.js"
import type { EvolutionIntent } from "./types.js"

// ── In-Memory SQLite Mock ────────────────────────────────────────────────────

function createInMemoryDb(): SqliteDb {
  const tables = new Map<string, unknown[]>()

  const mockStatement: SqliteStatement = {
    run: vi.fn().mockReturnValue({ changes: 1 }),
    get: vi.fn().mockReturnValue(undefined),
    all: vi.fn().mockReturnValue([]),
  }

  return {
    exec: vi.fn(),
    prepare: vi.fn().mockReturnValue(mockStatement),
  }
}

// ── Mock SlotGitOps ──────────────────────────────────────────────────────────

function createMockSlotGitOps(): SlotGitOps {
  return {
    getCurrentBranch: vi.fn().mockReturnValue("main"),
    createBranch: vi.fn(),
    checkout: vi.fn(),
    squashMerge: vi.fn(),
    commit: vi.fn(),
    diffFiles: vi.fn().mockReturnValue(["src/example.ts"]),
    revertHead: vi.fn(),
    deleteBranch: vi.fn(),
    getHeadCommit: vi.fn().mockReturnValue("abc123def"),
    stageAll: vi.fn(),
  }
}

// ── Mock Mutator Dependencies ────────────────────────────────────────────────

function createMockFs(): FileSystem {
  return {
    exists: vi.fn().mockReturnValue(true),
    read: vi.fn().mockReturnValue(
      `export function hello(): string {\n  return "hello"\n}\n`,
    ),
    write: vi.fn(),
  }
}

function createMockTypeChecker(): TypeChecker {
  return {
    check: vi.fn().mockReturnValue({ success: true, output: "" }),
  }
}

function createMockMutatorGitOps(): MutatorGitOps {
  return {
    add: vi.fn(),
    commit: vi.fn().mockReturnValue({ success: true }),
  }
}

function createMockLlm(): LlmClient {
  // Simulate LLM returning a valid unified diff + confidence
  const diffResponse = `\`\`\`diff
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,3 @@
 export function hello(): string {
-  return "hello"
+  return "hello world"
 }
\`\`\`

\`\`\`json
{
  "score": 0.9,
  "reason": "Simple string change, very straightforward",
  "uncertainties": []
}
\`\`\``

  return {
    chat: vi.fn().mockResolvedValue(diffResponse),
  }
}

function createMockFuzzyMatcher(): FuzzyMatcher {
  return {
    findAndReplace: vi.fn().mockImplementation((content, oldStr, newStr) => {
      if (content.includes(oldStr)) {
        return { success: true, result: content.replace(oldStr, newStr) }
      }
      return { success: false, result: content }
    }),
  }
}

// ── Mock Validator Dependencies ──────────────────────────────────────────────

function createMockCommandRunner(): CommandRunner {
  return {
    run: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "All tests passed",
      stderr: "",
      timedOut: false,
    } satisfies CommandResult),
  }
}

function createMockProcessSpawner(): ProcessSpawner {
  return {
    spawn: vi.fn().mockReturnValue({
      kill: vi.fn(),
      onExit: vi.fn(),
      exited: false,
    } satisfies ProcessHandle),
  }
}

function createMockHealthChecker(): HealthChecker {
  return {
    waitForHealth: vi.fn().mockResolvedValue(true),
  }
}

function createMockBehaviorTester(): BehaviorTester {
  return {
    testTrace: vi.fn().mockResolvedValue({
      traceId: "t1",
      statusCode: 200,
      responseLength: 100,
      responseToolSequence: [],
      toolSequenceMatch: true,
      lengthInRange: true,
      isError: false,
    }),
  }
}

function createMockTraceStore(): TraceStore {
  return {
    getRecentTraces: vi.fn().mockReturnValue([]),
  }
}

// ── Mock Monitor Dependencies ────────────────────────────────────────────────

function createMockHealthProbe(): HealthProbe {
  return {
    check: vi.fn().mockResolvedValue(true),
  }
}

function createMockErrorCounter(): ErrorCounter {
  return {
    getTotalRequests: vi.fn().mockReturnValue(100),
    getErrorCount: vi.fn().mockReturnValue(2),
  }
}

// ── Test Intent ──────────────────────────────────────────────────────────────

function makeTestIntent(): EvolutionIntent {
  return {
    id: "test-intent-001",
    type: "optimization",
    description: 'Change hello() to return "hello world"',
    targetFiles: ["src/example.ts"],
    evidence: ["User feedback: greeting should be more friendly"],
    riskLevel: "low",
    requiresHumanApproval: false,
    createdAt: Date.now(),
  }
}

// ── E2E Tests ────────────────────────────────────────────────────────────────

describe("E2E Evolution Smoke Test", () => {
  let slotGitOps: SlotGitOps
  let slotManager: SlotManager
  let safetyGuard: SafetyGuard
  let mutator: MutatorImpl
  let validator: ValidatorImpl
  let pipeline: EvolutionPipeline
  let mockFs: FileSystem
  let mockLlm: LlmClient
  let mockCommandRunner: CommandRunner

  beforeEach(() => {
    slotGitOps = createMockSlotGitOps()
    slotManager = new SlotManager(slotGitOps, { mainBranch: "main" })
    safetyGuard = new SafetyGuard({
      protectedPaths: ["src/config/", "src/twin-system/"],
      maxEvolutionsPerFile24h: 5,
    })

    mockFs = createMockFs()
    mockLlm = createMockLlm()

    const mutatorConfig: MutatorConfig = {
      maxRounds: 3,
      confidenceThreshold: 0.7,
      repoRoot: "/fake/repo",
    }

    mutator = new MutatorImpl({
      fs: mockFs,
      typeChecker: createMockTypeChecker(),
      git: createMockMutatorGitOps(),
      llm: mockLlm,
      config: mutatorConfig,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fuzzyMatcher: createMockFuzzyMatcher(),
    })

    mockCommandRunner = createMockCommandRunner()

    const validatorConfig: ValidatorConfig = {
      repoRoot: "/fake/repo",
      testPort: 19999,
      buildTimeoutMs: 60_000,
      testTimeoutMs: 60_000,
      healthCheckTimeoutMs: 10_000,
      minTracesForLevel2: 3,
      maxErrorRate: 0.3,
      minLengthPassRate: 0.5,
    }

    validator = new ValidatorImpl({
      commandRunner: mockCommandRunner,
      processSpawner: createMockProcessSpawner(),
      healthChecker: createMockHealthChecker(),
      behaviorTester: createMockBehaviorTester(),
      traceStore: createMockTraceStore(),
      config: validatorConfig,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })

    pipeline = new EvolutionPipeline({
      slotManager,
      safetyGuard,
      mutator,
      validator,
      config: {
        maxMutationRounds: 3,
        confidenceThreshold: 0.7,
        autoSwitch: true, // auto-switch for E2E test
        testPort: 19999,
        protectedPaths: ["src/config/", "src/twin-system/"],
        maxEvolutionsPerFile24h: 5,
        postSwitchMonitorMs: 300_000,
        failureRateThreshold: 0.1,
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
  })

  it("completes a full evolution cycle: intent → mutate → validate → switch", async () => {
    const intent = makeTestIntent()

    const result = await pipeline.run(intent)

    // Pipeline should succeed
    expect(result.success).toBe(true)
    expect(result.intentId).toBe("test-intent-001")

    // Mutation should have run
    expect(result.mutationResult).toBeDefined()
    expect(result.mutationResult!.success).toBe(true)
    expect(result.mutationResult!.changedFiles).toContain("src/example.ts")
    expect(result.mutationResult!.confidence.score).toBeGreaterThan(0.7)

    // Validation should have passed
    expect(result.validationResult).toBeDefined()
    expect(result.validationResult!.passed).toBe(true)
    expect(result.validationResult!.level).toBe(1)

    // Switch record should exist
    expect(result.switchRecord).toBeDefined()
    expect(result.switchRecord!.action).toBe("switch")
    expect(result.switchRecord!.success).toBe(true)

    // Events should trace the full lifecycle
    const eventTypes = result.events.map((e) => e.type)
    expect(eventTypes).toContain("pipeline_started")
    expect(eventTypes).toContain("mutation_started")
    expect(eventTypes).toContain("mutation_completed")
    expect(eventTypes).toContain("validation_started")
    expect(eventTypes).toContain("validation_completed")
    expect(eventTypes).toContain("switch_requested")
    expect(eventTypes).toContain("switch_completed")
    expect(eventTypes).toContain("pipeline_completed")
  })

  it("LLM is called with correct intent context", async () => {
    const intent = makeTestIntent()
    await pipeline.run(intent)

    // LLM should have been called
    expect(mockLlm.chat).toHaveBeenCalled()
    const callArgs = (mockLlm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // First message should be user message containing the intent
    expect(callArgs[0].role).toBe("user")
    expect(callArgs[0].content).toContain("hello")
    expect(callArgs[0].content).toContain(intent.description)
  })

  it("validates via build+test (Level 1)", async () => {
    const intent = makeTestIntent()
    await pipeline.run(intent)

    // CommandRunner should have been called for build and test
    expect(mockCommandRunner.run).toHaveBeenCalled()
    const calls = (mockCommandRunner.run as ReturnType<typeof vi.fn>).mock.calls
    // At least one call should be for build (pnpm build / npm run build)
    const hasBuiltOrTested = calls.some(
      (c: unknown[]) =>
        (c[0] as string).includes("pnpm") || (c[0] as string).includes("npm"),
    )
    expect(hasBuiltOrTested).toBe(true)
  })

  it("git operations follow correct sequence: branch → work → merge", async () => {
    const intent = makeTestIntent()
    await pipeline.run(intent)

    // SlotManager git ops sequence:
    // 1. checkout main
    expect(slotGitOps.checkout).toHaveBeenCalledWith("main")
    // 2. create evolution branch
    expect(slotGitOps.createBranch).toHaveBeenCalledWith(
      `evolution/${intent.id}`,
    )
    // 3. squash merge after validation
    expect(slotGitOps.squashMerge).toHaveBeenCalledWith(
      `evolution/${intent.id}`,
    )
    // 4. commit
    expect(slotGitOps.commit).toHaveBeenCalled()
    // 5. cleanup branch
    expect(slotGitOps.deleteBranch).toHaveBeenCalledWith(
      `evolution/${intent.id}`,
    )
  })

  it("safety guard blocks protected paths", async () => {
    const intent: EvolutionIntent = {
      ...makeTestIntent(),
      id: "test-blocked-001",
      targetFiles: ["src/config/schema.ts"],
    }

    const result = await pipeline.run(intent)

    expect(result.success).toBe(false)
    expect(result.abortReason).toContain("Safety check failed")
    expect(result.abortReason).toContain("Protected path")
  })

  it("pipeline aborts when mutation fails (type-check error)", async () => {
    // Make type checker fail
    const failingTypeChecker: TypeChecker = {
      check: vi.fn().mockReturnValue({
        success: false,
        output: "error TS2345: Argument of type 'string' is not assignable",
      }),
    }

    // Also make LLM fail on retry to exhaust rounds
    const failingLlm: LlmClient = {
      chat: vi.fn().mockResolvedValue(
        `\`\`\`diff
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,3 @@
 export function hello(): string {
-  return "hello"
+  return 42
 }
\`\`\`

\`\`\`json
{"score": 0.3, "reason": "Type error likely", "uncertainties": ["number vs string"]}
\`\`\``,
      ),
    }

    const failingMutator = new MutatorImpl({
      fs: mockFs,
      typeChecker: failingTypeChecker,
      git: createMockMutatorGitOps(),
      llm: failingLlm,
      config: { maxRounds: 2, confidenceThreshold: 0.7, repoRoot: "/fake/repo" },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fuzzyMatcher: createMockFuzzyMatcher(),
    })

    const failPipeline = new EvolutionPipeline({
      slotManager,
      safetyGuard,
      mutator: failingMutator,
      validator,
      config: {
        maxMutationRounds: 2,
        confidenceThreshold: 0.7,
        autoSwitch: true,
        testPort: 19999,
        protectedPaths: ["src/config/", "src/twin-system/"],
        maxEvolutionsPerFile24h: 5,
        postSwitchMonitorMs: 300_000,
        failureRateThreshold: 0.1,
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })

    const intent = makeTestIntent()
    const result = await failPipeline.run(intent)

    expect(result.success).toBe(false)
    expect(result.mutationResult).toBeDefined()
    expect(result.mutationResult!.success).toBe(false)
  })

  it("pipeline aborts when validation fails (build error)", async () => {
    // Make validator fail at build step
    const failingRunner: CommandRunner = {
      run: vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "Build failed: module not found",
        timedOut: false,
      } satisfies CommandResult),
    }

    const failingValidator = new ValidatorImpl({
      commandRunner: failingRunner,
      processSpawner: createMockProcessSpawner(),
      healthChecker: createMockHealthChecker(),
      behaviorTester: createMockBehaviorTester(),
      config: {
        repoRoot: "/fake/repo",
        testPort: 19999,
        buildTimeoutMs: 60_000,
        testTimeoutMs: 60_000,
        healthCheckTimeoutMs: 10_000,
        minTracesForLevel2: 3,
        maxErrorRate: 0.3,
        minLengthPassRate: 0.5,
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })

    const failPipeline = new EvolutionPipeline({
      slotManager,
      safetyGuard,
      mutator,
      validator: failingValidator,
      config: {
        maxMutationRounds: 3,
        confidenceThreshold: 0.7,
        autoSwitch: true,
        testPort: 19999,
        protectedPaths: ["src/config/", "src/twin-system/"],
        maxEvolutionsPerFile24h: 5,
        postSwitchMonitorMs: 300_000,
        failureRateThreshold: 0.1,
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })

    const intent = makeTestIntent()
    const result = await failPipeline.run(intent)

    expect(result.success).toBe(false)
    expect(result.abortReason).toContain("Validation failed")
    expect(result.mutationResult?.success).toBe(true) // mutation passed
  })

  it("requires approval for high-risk intents even with autoSwitch", async () => {
    const highRiskIntent: EvolutionIntent = {
      ...makeTestIntent(),
      id: "high-risk-001",
      riskLevel: "high",
      requiresHumanApproval: true,
    }

    // Pipeline with approval callback that denies
    const denyPipeline = new EvolutionPipeline({
      slotManager,
      safetyGuard,
      mutator,
      validator,
      config: {
        maxMutationRounds: 3,
        confidenceThreshold: 0.7,
        autoSwitch: true,
        testPort: 19999,
        protectedPaths: ["src/config/", "src/twin-system/"],
        maxEvolutionsPerFile24h: 5,
        postSwitchMonitorMs: 300_000,
        failureRateThreshold: 0.1,
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onApprovalNeeded: vi.fn().mockResolvedValue(false),
    })

    const result = await denyPipeline.run(highRiskIntent)

    // First approval check is from safety guard (requiresApproval=true for high risk)
    // The pipeline should block early
    expect(result.success).toBe(false)
    expect(result.abortReason).toContain("approval denied")
  })

  it("intent aggregator feeds pipeline correctly", async () => {
    const aggregator = new IntentAggregator()

    // Register a source that produces intents
    const source: IntentSource = {
      name: "test-source",
      generate: () => [
        {
          type: "optimization" as const,
          description: "Improve performance of hello()",
          targetFiles: ["src/example.ts"],
          evidence: ["profiling shows 100ms latency"],
          riskLevel: "low" as const,
        },
      ],
    }
    aggregator.addSource(source)

    // Collect intents
    const newIntents = await aggregator.collect()
    expect(newIntents).toHaveLength(1)

    // Pull intent and run through pipeline
    const intent = aggregator.next()
    expect(intent).not.toBeNull()
    expect(intent!.description).toBe("Improve performance of hello()")

    const result = await pipeline.run(intent!)
    expect(result.success).toBe(true)
  })

  it("post-switch monitor detects healthy state", async () => {
    const monitor = new PostSwitchMonitor({
      healthProbe: createMockHealthProbe(),
      errorCounter: createMockErrorCounter(),
      slotManager,
      config: {
        monitorWindowMs: 100, // Short window for test
        healthCheckIntervalMs: 20,
        errorRateCheckIntervalMs: 30,
        failureRateThreshold: 0.5,
        minRequestsForRateCheck: 10,
        maxConsecutiveHealthFailures: 3,
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })

    const mockRecord = {
      id: "rec-001",
      intentId: "test-intent-001",
      action: "switch" as const,
      success: true,
      fromSlot: "b" as const,
      toSlot: "a" as const,
      changedFiles: ["src/example.ts"],
      timestamp: Date.now(),
    }

    const result = await monitor.monitor(mockRecord)
    expect(result.passed).toBe(true)
    expect(result.rolledBack).toBe(false)
  })

  it("post-switch monitor triggers rollback on high error rate", async () => {
    const highErrorCounter: ErrorCounter = {
      getTotalRequests: vi.fn().mockReturnValue(100),
      getErrorCount: vi.fn().mockReturnValue(60), // 60% error rate
    }

    const monitorSlotGitOps = createMockSlotGitOps()
    const monitorSlotManager = new SlotManager(monitorSlotGitOps, {
      mainBranch: "main",
    })

    // Simulate that a switch has happened (so rollback has history)
    const switchIntent = makeTestIntent()
    monitorSlotGitOps.getCurrentBranch = vi.fn().mockReturnValue("main")
    monitorSlotManager.beginEvolution(switchIntent)
    ;(monitorSlotManager as any).updateSlot("b", { status: "validating" })
    monitorSlotManager.executeSwitch(switchIntent)

    const monitor = new PostSwitchMonitor({
      healthProbe: createMockHealthProbe(),
      errorCounter: highErrorCounter,
      slotManager: monitorSlotManager,
      config: {
        monitorWindowMs: 100,
        healthCheckIntervalMs: 20,
        errorRateCheckIntervalMs: 30,
        failureRateThreshold: 0.1, // 10% threshold, actual is 60%
        minRequestsForRateCheck: 10,
        maxConsecutiveHealthFailures: 3,
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })

    const mockRecord = {
      id: "rec-002",
      intentId: switchIntent.id,
      action: "switch" as const,
      success: true,
      fromSlot: "b" as const,
      toSlot: "a" as const,
      changedFiles: ["src/example.ts"],
      timestamp: Date.now(),
    }

    const result = await monitor.monitor(mockRecord)
    expect(result.rolledBack).toBe(true)
    expect(result.passed).toBe(false)
    expect(result.rollbackReason?.toLowerCase()).toContain("error rate")
  })

  it("full cycle with persistence records evolution frequency", () => {
    const db = createInMemoryDb()
    const persistence = new PersistenceAdapter(db)

    // Record an evolution
    persistence.recordEvolution("src/example.ts")

    // Verify frequency store works (mock returns count)
    const stmt = db.prepare("") as SqliteStatement
    ;(stmt.get as ReturnType<typeof vi.fn>).mockReturnValue({ cnt: 1 })

    const count = persistence.getEvolutionCount(
      "src/example.ts",
      24 * 60 * 60 * 1000,
    )
    // The mock always returns whatever get() returns
    expect(count).toBe(1)
  })

  it("complete integration: aggregator → pipeline → persistence", async () => {
    // This test validates the full wiring path that factory.ts creates

    const aggregator = new IntentAggregator()
    const db = createInMemoryDb()
    const persistence = new PersistenceAdapter(db)

    // Setup source
    aggregator.addSource({
      name: "knowledge",
      generate: () => [
        {
          type: "behavior_fix" as const,
          description: "Fix greeting to be more friendly",
          targetFiles: ["src/example.ts"],
          evidence: ["User complained about unfriendly greeting"],
          riskLevel: "low" as const,
        },
      ],
    })

    // Collect
    await aggregator.collect()
    const intent = aggregator.next()
    expect(intent).not.toBeNull()

    // Run pipeline
    const result = await pipeline.run(intent!)
    expect(result.success).toBe(true)

    // Record frequency (mimics what factory.ts does in onTrigger)
    for (const file of result.mutationResult?.changedFiles ?? []) {
      persistence.recordEvolution(file)
    }

    // Verify it was recorded
    expect(db.prepare).toHaveBeenCalled()
  })
})
