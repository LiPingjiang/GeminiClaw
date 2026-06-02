/**
 * ValidatorImpl — Fully typed implementation of the Validator interface.
 *
 * Ports logic from src/evolution/validator/validator.ts:
 *   Level 1: pnpm build + pnpm test (static validation)
 *   Level 2: Build → start temp process → health check → replay traces → behavior metrics
 *
 * All external side-effects injected via interfaces for testability.
 */

import type { EvolutionIntent, ValidationResult } from "./types.js"
import type { Validator } from "./evolution-pipeline.js"

// ── Dependency Interfaces ────────────────────────────────────────────────────

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    env?: Record<string, string>,
  ): Promise<CommandResult>
}

export interface ProcessHandle {
  kill(signal?: string): void
  onExit(cb: () => void): void
  readonly exited: boolean
}

export interface ProcessSpawner {
  spawn(
    cmd: string,
    args: string[],
    cwd: string,
    env?: Record<string, string>,
  ): ProcessHandle
}

export interface HealthChecker {
  waitForHealth(port: number, timeoutMs: number): Promise<boolean>
}

export interface TraceRecord {
  id: string
  messageCount: number
  toolSequence: string[]
  hadFailure: boolean
  responseLength: number
}

export interface TraceStore {
  getRecentTraces(limit: number): TraceRecord[]
}

export interface TraceTestResult {
  traceId: string
  statusCode: number
  responseLength: number
  responseToolSequence: string[]
  toolSequenceMatch: boolean
  lengthInRange: boolean
  isError: boolean
}

export interface BehaviorTester {
  testTrace(
    port: number,
    trace: TraceRecord,
    originalLength: number,
  ): Promise<TraceTestResult>
}

export interface ValidatorLogger {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

export interface ValidatorConfig {
  repoRoot: string
  testPort: number
  buildTimeoutMs: number
  testTimeoutMs: number
  healthCheckTimeoutMs: number
  /** Minimum traces required for Level 2 */
  minTracesForLevel2: number
  /** Max error rate before Level 2 fails */
  maxErrorRate: number
  /** Min length check pass rate for Level 2 */
  minLengthPassRate: number
}

export const DEFAULT_VALIDATOR_CONFIG: ValidatorConfig = {
  repoRoot: process.cwd(),
  testPort: 19889,
  buildTimeoutMs: 3 * 60_000,
  testTimeoutMs: 5 * 60_000,
  healthCheckTimeoutMs: 30_000,
  minTracesForLevel2: 3,
  maxErrorRate: 0.3,
  minLengthPassRate: 0.5,
}

// ── Trace Selection (exported for testing) ───────────────────────────────────

/**
 * Select up to 5 representative traces for Level 2 testing.
 * Strategy: most messages + most tools + shortest + failure + random.
 */
export function selectTraces(traces: TraceRecord[]): TraceRecord[] {
  if (traces.length === 0) return []

  const selected = new Map<string, TraceRecord>()

  // Most messages (most complex interaction)
  const sorted = [...traces].sort(
    (a, b) => b.messageCount - a.messageCount,
  )
  if (sorted[0]) selected.set(sorted[0].id, sorted[0])

  // Most tools (most complex tool usage)
  const byTools = [...traces].sort(
    (a, b) => b.toolSequence.length - a.toolSequence.length,
  )
  if (byTools[0]) selected.set(byTools[0].id, byTools[0])

  // Shortest (fewest messages — edge case coverage)
  const byShortest = [...traces].sort(
    (a, b) => a.messageCount - b.messageCount,
  )
  if (byShortest[0]) selected.set(byShortest[0].id, byShortest[0])

  // Failure traces (regression-prone)
  const failures = traces.filter((t) => t.hadFailure)
  if (failures[0]) selected.set(failures[0].id, failures[0])

  // Random from remaining
  const remaining = traces.filter((t) => !selected.has(t.id))
  if (remaining.length > 0) {
    const randomIdx = Math.floor(Math.random() * remaining.length)
    const pick = remaining[randomIdx]
    if (pick) selected.set(pick.id, pick)
  }

  return Array.from(selected.values()).slice(0, 5)
}

// ── ValidatorImpl ────────────────────────────────────────────────────────────

export interface ValidatorImplDeps {
  commandRunner: CommandRunner
  processSpawner: ProcessSpawner
  healthChecker: HealthChecker
  behaviorTester: BehaviorTester
  traceStore?: TraceStore
  config: ValidatorConfig
  logger: ValidatorLogger
}

export class ValidatorImpl implements Validator {
  private readonly commandRunner: CommandRunner
  private readonly processSpawner: ProcessSpawner
  private readonly healthChecker: HealthChecker
  private readonly behaviorTester: BehaviorTester
  private readonly traceStore?: TraceStore
  private readonly config: ValidatorConfig
  private readonly logger: ValidatorLogger

  constructor(deps: ValidatorImplDeps) {
    this.commandRunner = deps.commandRunner
    this.processSpawner = deps.processSpawner
    this.healthChecker = deps.healthChecker
    this.behaviorTester = deps.behaviorTester
    this.traceStore = deps.traceStore
    this.config = deps.config
    this.logger = deps.logger
  }

  /**
   * Level 1 validation: pnpm build + pnpm test.
   */
  async validate(_intent: EvolutionIntent): Promise<ValidationResult> {
    const start = Date.now()
    this.logger.info("Starting Level 1 validation (build + test)")

    // Step 1: pnpm build
    this.logger.info("Running pnpm build...")
    const buildResult = await this.commandRunner.run(
      "pnpm",
      ["build"],
      this.config.repoRoot,
      this.config.buildTimeoutMs,
    )

    const buildPassed = buildResult.exitCode === 0 && !buildResult.timedOut
    if (!buildPassed) {
      const reason = buildResult.timedOut
        ? `pnpm build timed out after ${this.config.buildTimeoutMs / 1000}s`
        : `pnpm build failed (exit ${buildResult.exitCode})`
      this.logger.warn("Build failed: %s", reason)

      return {
        level: 1,
        passed: false,
        reason,
        details: JSON.stringify({
          buildPassed: false,
          testsPassed: false,
          buildOutput: buildResult.stderr.slice(0, 2000),
        }),
        durationMs: Date.now() - start,
      }
    }

    this.logger.info("Build passed")

    // Step 2: pnpm test
    this.logger.info("Running pnpm test...")
    const testResult = await this.commandRunner.run(
      "pnpm",
      ["test"],
      this.config.repoRoot,
      this.config.testTimeoutMs,
    )

    const testsPassed = testResult.exitCode === 0 && !testResult.timedOut
    if (!testsPassed) {
      const reason = testResult.timedOut
        ? `pnpm test timed out after ${this.config.testTimeoutMs / 1000}s`
        : `pnpm test failed (exit ${testResult.exitCode})`
      this.logger.warn("Tests failed: %s", reason)

      return {
        level: 1,
        passed: false,
        reason,
        details: JSON.stringify({
          buildPassed: true,
          testsPassed: false,
          testOutput: testResult.stdout.slice(0, 2000),
        }),
        durationMs: Date.now() - start,
      }
    }

    this.logger.info("Tests passed")

    return {
      level: 1,
      passed: true,
      details: JSON.stringify({ buildPassed: true, testsPassed: true }),
      durationMs: Date.now() - start,
    }
  }

  /**
   * Level 2 validation: Behavioral assertions via temporary process.
   */
  async validateLevel2(intent: EvolutionIntent): Promise<ValidationResult> {
    const start = Date.now()
    const { testPort } = this.config

    this.logger.info(
      "Starting Level 2 validation (behavior assertions) for intent %s",
      intent.id,
    )

    // Check trace store availability
    if (!this.traceStore) {
      this.logger.warn("Level 2 skipped: no trace store provided")
      return {
        level: 2,
        passed: true,
        reason: "no_trace_store",
        details: JSON.stringify({ skipped: true, reason: "no_trace_store" }),
        durationMs: Date.now() - start,
      }
    }

    // Get recent traces
    const recentTraces = this.traceStore.getRecentTraces(20)
    if (recentTraces.length < this.config.minTracesForLevel2) {
      this.logger.info(
        "Level 2 skipped: insufficient traces (%d < %d)",
        recentTraces.length,
        this.config.minTracesForLevel2,
      )
      return {
        level: 2,
        passed: true,
        reason: "insufficient_traces",
        details: JSON.stringify({
          skipped: true,
          reason: "insufficient_traces",
          traceCount: recentTraces.length,
        }),
        durationMs: Date.now() - start,
      }
    }

    // Select representative traces
    const selectedTraces = selectTraces(recentTraces)
    this.logger.info(
      "Level 2: selected %d traces for testing",
      selectedTraces.length,
    )

    // Build current code
    this.logger.info("Level 2: running pnpm build...")
    const buildResult = await this.commandRunner.run(
      "pnpm",
      ["build"],
      this.config.repoRoot,
      this.config.buildTimeoutMs,
    )

    if (buildResult.exitCode !== 0 || buildResult.timedOut) {
      const buildReason = buildResult.timedOut
        ? "build_timeout"
        : "build_failed"
      this.logger.warn("Level 2: build failed (%s)", buildReason)
      return {
        level: 2,
        passed: false,
        reason: "startup_failed",
        details: JSON.stringify({
          reason: "startup_failed",
          buildReason,
          buildOutput: buildResult.stderr.slice(0, 1000),
        }),
        durationMs: Date.now() - start,
      }
    }

    // Start temporary process
    this.logger.info(
      "Level 2: starting temporary process on port %d",
      testPort,
    )
    const proc = this.processSpawner.spawn(
      "node",
      ["dist/index.js", "--port", String(testPort)],
      this.config.repoRoot,
      { PORT: String(testPort) },
    )

    try {
      // Wait for health
      const isHealthy = await this.healthChecker.waitForHealth(
        testPort,
        this.config.healthCheckTimeoutMs,
      )

      if (!isHealthy || proc.exited) {
        const detail = proc.exited
          ? "process exited prematurely"
          : "health check timeout"
        this.logger.warn("Level 2: temporary process failed to start (%s)", detail)
        return {
          level: 2,
          passed: false,
          reason: "startup_failed",
          details: JSON.stringify({ reason: "startup_failed", detail }),
          durationMs: Date.now() - start,
        }
      }

      // Run behavior tests
      const results: TraceTestResult[] = []
      for (const trace of selectedTraces) {
        const estimatedOriginalLength =
          trace.responseLength > 0
            ? trace.responseLength
            : Math.max(50, trace.messageCount * 100)
        const result = await this.behaviorTester.testTrace(
          testPort,
          trace,
          estimatedOriginalLength,
        )
        results.push(result)
        this.logger.info(
          "Level 2: trace %s → status=%d, lengthInRange=%s, toolMatch=%s, isError=%s",
          trace.id,
          result.statusCode,
          result.lengthInRange,
          result.toolSequenceMatch,
          result.isError,
        )
      }

      // Compute metrics
      const totalRequests = results.length
      const errorCount = results.filter((r) => r.isError).length
      const errorRate = totalRequests > 0 ? errorCount / totalRequests : 0
      const lengthPassCount = results.filter((r) => r.lengthInRange).length
      const lengthCheckPassRate =
        totalRequests > 0 ? lengthPassCount / totalRequests : 0
      const toolMatchCount = results.filter(
        (r) => r.toolSequenceMatch,
      ).length
      const toolSequenceMatchRate =
        totalRequests > 0 ? toolMatchCount / totalRequests : 0

      const behaviorCheck = {
        tracesUsed: totalRequests,
        errorRate,
        lengthCheckPassRate,
        toolSequenceMatchRate,
      }

      // Check failure conditions
      if (errorRate > this.config.maxErrorRate) {
        this.logger.warn(
          "Level 2 FAILED: errorRate=%.2f > %.2f",
          errorRate,
          this.config.maxErrorRate,
        )
        return {
          level: 2,
          passed: false,
          reason: `high_error_rate: ${errorRate.toFixed(2)}`,
          details: JSON.stringify({
            passed: false,
            reason: "high_error_rate",
            ...behaviorCheck,
          }),
          durationMs: Date.now() - start,
        }
      }

      if (lengthCheckPassRate < this.config.minLengthPassRate) {
        this.logger.warn(
          "Level 2 FAILED: lengthCheckPassRate=%.2f < %.2f",
          lengthCheckPassRate,
          this.config.minLengthPassRate,
        )
        return {
          level: 2,
          passed: false,
          reason: `low_length_pass_rate: ${lengthCheckPassRate.toFixed(2)}`,
          details: JSON.stringify({
            passed: false,
            reason: "low_length_pass_rate",
            ...behaviorCheck,
          }),
          durationMs: Date.now() - start,
        }
      }

      this.logger.info(
        "Level 2 PASSED: errorRate=%.2f, lengthPassRate=%.2f, toolMatchRate=%.2f",
        errorRate,
        lengthCheckPassRate,
        toolSequenceMatchRate,
      )
      return {
        level: 2,
        passed: true,
        details: JSON.stringify({ passed: true, ...behaviorCheck }),
        durationMs: Date.now() - start,
      }
    } finally {
      // Always kill the temporary process
      if (!proc.exited) {
        try {
          proc.kill("SIGTERM")
          this.logger.info("Level 2: killed temporary process")
        } catch {
          // ignore
        }
      }
    }
  }
}
