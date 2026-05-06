// src/evolution/validator/validator.ts
// Validator: validates code changes after Mutator runs.
// Phase B implements Level 1 (static checks: build + test).
// Phase C adds Level 2 (structural behavior assertions via temporary process).

import { spawn } from "child_process"
import type { Intent, ValidationResult, ValidationResultBehaviorCheck } from "../types.js"
import type { EvolutionConfig } from "../types.js"
import type { EvolutionDB } from "../db.js"
import type { Logger } from "../index.js"

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export interface ValidatorParams {
  repoRoot: string
  config: EvolutionConfig["validator"]
  logger: Logger
  db?: EvolutionDB
}

interface SpawnResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Run a command with a timeout using AbortController.
 * Uses spawn (not exec) to avoid shell injection and enable streaming output.
 */
function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    const proc = spawn(cmd, args, {
      cwd,
      signal: controller.signal,
      stdio: ["ignore", "pipe", "pipe"],
      env: env ?? process.env,
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on("close", (code) => {
      clearTimeout(timer)
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut,
      })
    })

    proc.on("error", (err) => {
      clearTimeout(timer)
      const isAbort = err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ABORT_ERR"
      if (isAbort) {
        timedOut = true
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr + "\n[TIMEOUT] Command timed out",
          timedOut: true,
        })
      } else {
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr + `\n[ERROR] ${err.message}`,
          timedOut: false,
        })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Level 2: Behavior assertion helpers
// ---------------------------------------------------------------------------

interface TraceForTest {
  id: string
  toolSequence: string[]
  hadFailure: boolean
  messageCount: number
  responseLength: number
}

interface BehaviorTestResult {
  traceId: string
  statusCode: number
  responseLength: number
  responseToolSequence: string[]
  toolSequenceMatch: boolean
  lengthInRange: boolean
  isError: boolean
}

/**
 * Select up to 5 representative traces for Level 2 testing.
 * Strategy: most recent + highest failure + most tools + shortest + random.
 */
function selectTraces(traces: TraceForTest[]): TraceForTest[] {
  if (traces.length === 0) return []

  const selected = new Map<string, TraceForTest>()

  // Most recent
  const sorted = [...traces].sort((a, b) => b.messageCount - a.messageCount)
  if (sorted[0]) selected.set(sorted[0].id, sorted[0])

  // Most tools (most complex)
  const byTools = [...traces].sort((a, b) => b.toolSequence.length - a.toolSequence.length)
  if (byTools[0]) selected.set(byTools[0].id, byTools[0])

  // Shortest (fewest messages)
  const byShortest = [...traces].sort((a, b) => a.messageCount - b.messageCount)
  if (byShortest[0]) selected.set(byShortest[0].id, byShortest[0])

  // Failure traces (if any)
  const failures = traces.filter(t => t.hadFailure)
  if (failures.length > 0) {
    selected.set(failures[0].id, failures[0])
  }

  // Random from remaining
  const remaining = traces.filter(t => !selected.has(t.id))
  if (remaining.length > 0) {
    const randomIdx = Math.floor(Math.random() * remaining.length)
    const randomTrace = remaining[randomIdx]
    if (randomTrace) selected.set(randomTrace.id, randomTrace)
  }

  return Array.from(selected.values()).slice(0, 5)
}

/**
 * Poll /v1/health until the server is up or timeout expires.
 */
async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const healthUrl = `http://127.0.0.1:${port}/v1/health`

  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

/**
 * Send a test request to the temporary process and collect behavior metrics.
 */
async function testTrace(
  port: number,
  trace: TraceForTest,
  originalLength: number
): Promise<BehaviorTestResult> {
  const url = `http://127.0.0.1:${port}/v1/agent/chat`

  // Build a synthetic message based on trace characteristics
  const message = trace.toolSequence.length > 0
    ? `Test request with tools: ${trace.toolSequence.slice(0, 3).join(", ")}`
    : "Hello, this is a test message."

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, session_id: `level2-test-${trace.id}` }),
      signal: AbortSignal.timeout(15000),
    })

    const isError = res.status >= 500

    let responseBody = ""
    let responseToolSequence: string[] = []

    try {
      const json = await res.json() as Record<string, unknown>
      responseBody = JSON.stringify(json)
      // Extract tool sequence from response if present
      if (Array.isArray(json["tool_calls"])) {
        responseToolSequence = (json["tool_calls"] as Array<{ name?: string }>)
          .map(t => t.name ?? "unknown")
      } else if (typeof json["content"] === "string") {
        responseBody = json["content"] as string
      }
    } catch {
      responseBody = await res.text().catch(() => "")
    }

    const responseLength = responseBody.length

    // Tool sequence match: all original tools should be present (order-independent)
    const toolSequenceMatch = trace.toolSequence.length === 0
      ? true
      : trace.toolSequence.every(tool => responseToolSequence.includes(tool))

    // Length in range: [0.3x, 3x] of original length
    const minLen = Math.max(1, Math.floor(originalLength * 0.3))
    const maxLen = Math.max(1, Math.ceil(originalLength * 3))
    const lengthInRange = responseLength >= minLen && responseLength <= maxLen

    return {
      traceId: trace.id,
      statusCode: res.status,
      responseLength,
      responseToolSequence,
      toolSequenceMatch,
      lengthInRange,
      isError,
    }
  } catch {
    return {
      traceId: trace.id,
      statusCode: 0,
      responseLength: 0,
      responseToolSequence: [],
      toolSequenceMatch: false,
      lengthInRange: false,
      isError: true,
    }
  }
}

export class Validator {
  private repoRoot: string
  private config: EvolutionConfig["validator"]
  private logger: Logger
  private db?: EvolutionDB

  constructor(params: ValidatorParams) {
    this.repoRoot = params.repoRoot
    this.config = params.config
    this.logger = params.logger
    this.db = params.db
  }

  /**
   * Validate the current state of the repo after mutation.
   * Level 1: pnpm build + pnpm test
   */
  async validate(_intent: Intent): Promise<ValidationResult> {
    const start = Date.now()
    this.logger.info("Starting Level 1 validation (build + test)")

    // Step 1: pnpm build (3 minute timeout)
    this.logger.info("Running pnpm build...")
    const buildResult = await runCommand("pnpm", ["build"], this.repoRoot, 3 * 60_000)

    const buildPassed = buildResult.exitCode === 0 && !buildResult.timedOut
    if (!buildPassed) {
      const reason = buildResult.timedOut
        ? "pnpm build timed out after 3 minutes"
        : `pnpm build failed (exit ${buildResult.exitCode})`
      this.logger.warn("Build failed: %s", reason)
      this.logger.warn("Build stderr:\n%s", buildResult.stderr.slice(0, 2000))

      return {
        level: 1,
        passed: false,
        reason,
        staticCheck: { buildPassed: false, testsPassed: false, lintPassed: false },
        details: JSON.stringify({
          buildPassed: false,
          testsPassed: false,
          lintPassed: false,
          buildOutput: buildResult.stderr.slice(0, 2000) + buildResult.stdout.slice(0, 500),
          reason,
        }),
        durationMs: Date.now() - start,
      }
    }

    this.logger.info("Build passed ✓")

    // Step 2: pnpm test (5 minute timeout)
    this.logger.info("Running pnpm test...")
    const testResult = await runCommand("pnpm", ["test"], this.repoRoot, 5 * 60_000)

    const testsPassed = testResult.exitCode === 0 && !testResult.timedOut
    if (!testsPassed) {
      const reason = testResult.timedOut
        ? "pnpm test timed out after 5 minutes"
        : `pnpm test failed (exit ${testResult.exitCode})`
      this.logger.warn("Tests failed: %s", reason)
      this.logger.warn("Test output:\n%s", testResult.stdout.slice(0, 2000))

      return {
        level: 1,
        passed: false,
        reason,
        staticCheck: { buildPassed: true, testsPassed: false, lintPassed: false },
        details: JSON.stringify({
          buildPassed: true,
          testsPassed: false,
          lintPassed: false,
          testOutput: testResult.stdout.slice(0, 2000) + testResult.stderr.slice(0, 500),
          reason,
        }),
        durationMs: Date.now() - start,
      }
    }

    this.logger.info("Tests passed ✓")

    return {
      level: 1,
      passed: true,
      staticCheck: { buildPassed: true, testsPassed: true, lintPassed: false },
      details: JSON.stringify({
        buildPassed: true,
        testsPassed: true,
        lintPassed: false,  // lint not implemented in Phase B
      }),
      durationMs: Date.now() - start,
    }
  }

  /**
   * Level 2: Structural behavior assertions.
   * Builds the current branch, starts a temporary process on testPort,
   * replays representative traces, and checks behavior metrics.
   */
  async validateLevel2(intent: Intent): Promise<ValidationResult> {
    const start = Date.now()
    const testPort = this.config.testPort ?? 19889

    this.logger.info("Starting Level 2 validation (behavior assertions) for intent %s", intent.id)

    // Get recent traces from DB
    if (!this.db) {
      this.logger.warn("Level 2 skipped: no DB provided")
      return {
        level: 2,
        passed: true,
        skipped: true,
        reason: "no_db",
        details: JSON.stringify({ skipped: true, reason: "no_db" }),
        durationMs: Date.now() - start,
      }
    }

    const recentTraces = this.db.getRecentTraces(20)

    if (recentTraces.length < 3) {
      this.logger.info("Level 2 skipped: insufficient traces (%d < 3)", recentTraces.length)
      return {
        level: 2,
        passed: true,
        skipped: true,
        reason: "insufficient_traces",
        details: JSON.stringify({ skipped: true, reason: "insufficient_traces", traceCount: recentTraces.length }),
        durationMs: Date.now() - start,
      }
    }

    // Select representative traces
    const selectedTraces = selectTraces(recentTraces)
    this.logger.info("Level 2: selected %d traces for testing", selectedTraces.length)

    // Build the current code
    this.logger.info("Level 2: running pnpm build...")
    const buildResult = await runCommand("pnpm", ["build"], this.repoRoot, 3 * 60_000)
    if (buildResult.exitCode !== 0 || buildResult.timedOut) {
      const reason = buildResult.timedOut ? "build_timeout" : "build_failed"
      this.logger.warn("Level 2: build failed (%s)", reason)
      return {
        level: 2,
        passed: false,
        reason: "startup_failed",
        details: JSON.stringify({
          reason: "startup_failed",
          buildReason: reason,
          buildOutput: buildResult.stderr.slice(0, 1000),
        }),
        durationMs: Date.now() - start,
      }
    }

    // Start temporary process on testPort
    this.logger.info("Level 2: starting temporary process on port %d", testPort)
    const tmpProc = spawn("node", ["dist/index.js", "--port", String(testPort)], {
      cwd: this.repoRoot,
      stdio: "pipe",
      env: { ...process.env, PORT: String(testPort) },
    })

    let procExited = false
    tmpProc.on("exit", () => { procExited = true })

    try {
      // Wait for health check (up to 30 seconds)
      const isHealthy = await waitForHealth(testPort, 30_000)
      if (!isHealthy) {
        this.logger.warn("Level 2: temporary process failed to start (health check timeout)")
        return {
          level: 2,
          passed: false,
          reason: "startup_failed",
          details: JSON.stringify({ reason: "startup_failed", detail: "health check timeout" }),
          durationMs: Date.now() - start,
        }
      }

      if (procExited) {
        this.logger.warn("Level 2: temporary process exited before health check passed")
        return {
          level: 2,
          passed: false,
          reason: "startup_failed",
          details: JSON.stringify({ reason: "startup_failed", detail: "process exited prematurely" }),
          durationMs: Date.now() - start,
        }
      }

      // Run behavior tests against each trace
      const results: BehaviorTestResult[] = []
      for (const trace of selectedTraces) {
        // Use actual recorded response length; fall back to messageCount estimate only if 0
        const estimatedOriginalLength = trace.responseLength > 0
          ? trace.responseLength
          : Math.max(50, trace.messageCount * 100)
        const result = await testTrace(testPort, trace, estimatedOriginalLength)
        results.push(result)
        this.logger.info(
          "Level 2: trace %s → status=%d, lengthInRange=%s, toolMatch=%s, isError=%s",
          trace.id, result.statusCode, result.lengthInRange, result.toolSequenceMatch, result.isError
        )
      }

      // Compute metrics
      const totalRequests = results.length
      const errorCount = results.filter(r => r.isError).length
      const errorRate = totalRequests > 0 ? errorCount / totalRequests : 0
      const lengthPassCount = results.filter(r => r.lengthInRange).length
      const lengthCheckPassRate = totalRequests > 0 ? lengthPassCount / totalRequests : 0
      const toolMatchCount = results.filter(r => r.toolSequenceMatch).length
      const toolSequenceMatchRate = totalRequests > 0 ? toolMatchCount / totalRequests : 0

      const behaviorCheck: ValidationResultBehaviorCheck = {
        tracesUsed: totalRequests,
        errorRate,
        lengthCheckPassRate,
        toolSequenceMatchRate,
      }

      // Failure conditions
      if (errorRate > 0.3) {
        this.logger.warn("Level 2 FAILED: errorRate=%.2f > 0.3", errorRate)
        return {
          level: 2,
          passed: false,
          reason: `high_error_rate: ${errorRate.toFixed(2)}`,
          behaviorCheck,
          details: JSON.stringify({ passed: false, reason: "high_error_rate", ...behaviorCheck }),
          durationMs: Date.now() - start,
        }
      }

      if (lengthCheckPassRate < 0.5) {
        this.logger.warn("Level 2 FAILED: lengthCheckPassRate=%.2f < 0.5", lengthCheckPassRate)
        return {
          level: 2,
          passed: false,
          reason: `low_length_pass_rate: ${lengthCheckPassRate.toFixed(2)}`,
          behaviorCheck,
          details: JSON.stringify({ passed: false, reason: "low_length_pass_rate", ...behaviorCheck }),
          durationMs: Date.now() - start,
        }
      }

      this.logger.info(
        "Level 2 PASSED: errorRate=%.2f, lengthPassRate=%.2f, toolMatchRate=%.2f",
        errorRate, lengthCheckPassRate, toolSequenceMatchRate
      )

      return {
        level: 2,
        passed: true,
        behaviorCheck,
        details: JSON.stringify({ passed: true, ...behaviorCheck }),
        durationMs: Date.now() - start,
      }
    } finally {
      // Always kill the temporary process
      if (!procExited) {
        try {
          tmpProc.kill("SIGTERM")
          this.logger.info("Level 2: killed temporary process")
        } catch {
          // ignore
        }
      }
    }
  }
}
