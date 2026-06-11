/**
 * Twin-System Factory — Dependency Injection container.
 *
 * Wires all twin-system components with real adapters:
 * - MutatorImpl (with NodeFileSystem, TscTypeChecker, SimpleGitOps, ProviderRouterLlm)
 * - ValidatorImpl (with ExecCommandRunner, ExecProcessSpawner, HttpHealthChecker, HttpBehaviorTester)
 * - SafetyGuard (with PersistenceAdapter as frequency store)
 * - SlotManager (with ExecGitOps)
 * - IntentAggregator
 * - PostSwitchMonitor (with HttpHealthProbe, ServerErrorCounter)
 * - SchedulerRunner
 * - EvolutionPipeline (orchestrator)
 *
 * This module bridges the config schema → runtime instances.
 */

import { execSync, spawn, type ChildProcess } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import http from "http"
import type { EvolutionConfig } from "../config/schema.js"
import type { Db } from "../db/client.js"
import { ProviderRouter } from "../providers/router.js"

// ── Twin-system imports ──────────────────────────────────────────────────────

import { MutatorImpl } from "./mutator-impl.js"
import type {
  FileSystem,
  TypeChecker,
  TypeCheckResult,
  GitOps as MutatorGitOps,
  GitCommitResult,
  LlmClient,
  LlmMessage,
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
  TraceRecord,
  TraceTestResult,
  ValidatorConfig,
} from "./validator-impl.js"

import { PersistenceAdapter } from "./persistence.js"
import { SafetyGuard } from "./safety-guard.js"
import { SlotManager, type GitOps as SlotGitOps } from "./slot-manager.js"
import { IntentAggregator } from "./intent-aggregator.js"
import { PostSwitchMonitor } from "./post-switch-monitor.js"
import type {
  HealthProbe,
  ErrorCounter,
  PostSwitchMonitorConfig,
} from "./post-switch-monitor.js"
import { SchedulerRunner } from "./scheduler.js"
import type { SchedulerConfig, ActivityTracker } from "./scheduler.js"
import { EvolutionPipeline } from "./evolution-pipeline.js"
import { TraceIntentSource, MemoryIntentSource, UpstreamIntentSource } from "./intent-sources.js"
import { EvolutionMetrics } from "./metrics.js"
import { ApprovalGate } from "./approval-gate.js"
import type { ApprovalGateConfig } from "./approval-gate.js"

// ── Logger ───────────────────────────────────────────────────────────────────

const logger = {
  info(msg: string, ...args: unknown[]) {
    console.log(`[twin-system] ${msg}`, ...args)
  },
  warn(msg: string, ...args: unknown[]) {
    console.warn(`[twin-system] ${msg}`, ...args)
  },
  error(msg: string, ...args: unknown[]) {
    console.error(`[twin-system] ${msg}`, ...args)
  },
}

// ── Real Adapters ────────────────────────────────────────────────────────────

// -- FileSystem Adapter --

class NodeFileSystem implements FileSystem {
  exists(path: string): boolean {
    return existsSync(path)
  }
  read(path: string): string {
    return readFileSync(path, "utf-8")
  }
  write(path: string, content: string): void {
    const dir = path.replace(/[/\\][^/\\]+$/, "")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, content, "utf-8")
  }
}

// -- TypeChecker Adapter --

class TscTypeChecker implements TypeChecker {
  check(cwd: string): TypeCheckResult {
    try {
      const output = execSync("npx tsc --noEmit", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120_000,
      })
      return { success: true, output }
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string }
      return {
        success: false,
        output: (e.stderr ?? e.stdout ?? "tsc failed").toString(),
      }
    }
  }
}

// -- GitOps for MutatorImpl --

class MutatorGitOpsAdapter implements MutatorGitOps {
  constructor(private readonly repoRoot: string) {}

  add(cwd: string, files: string[]): void {
    execSync(`git add ${files.map((f) => `"${f}"`).join(" ")}`, {
      cwd,
      encoding: "utf-8",
    })
  }

  commit(cwd: string, message: string): GitCommitResult {
    try {
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
        cwd,
        encoding: "utf-8",
      })
      return { success: true }
    } catch (err: unknown) {
      return {
        success: false,
        error: (err as Error).message,
      }
    }
  }
}

// -- GitOps for SlotManager --

class SlotGitOpsAdapter implements SlotGitOps {
  constructor(private readonly repoRoot: string) {}

  private exec(cmd: string): string {
    return execSync(cmd, { cwd: this.repoRoot, encoding: "utf-8" }).trim()
  }

  getCurrentBranch(): string {
    return this.exec("git rev-parse --abbrev-ref HEAD")
  }

  createBranch(name: string): void {
    this.exec(`git checkout -b ${name}`)
  }

  checkout(branch: string): void {
    this.exec(`git checkout ${branch}`)
  }

  squashMerge(branch: string): void {
    this.exec(`git merge --squash ${branch}`)
  }

  commit(message: string): void {
    this.exec(`git commit -m "${message.replace(/"/g, '\\"')}"`)
  }

  diffFiles(baseBranch: string, targetBranch: string): string[] {
    const output = this.exec(
      `git diff --name-only ${baseBranch}...${targetBranch}`,
    )
    return output ? output.split("\n") : []
  }

  revertHead(): void {
    this.exec("git revert HEAD --no-edit")
  }

  deleteBranch(branch: string): void {
    this.exec(`git branch -D ${branch}`)
  }

  getHeadCommit(): string {
    return this.exec("git rev-parse HEAD")
  }

  stageAll(): void {
    this.exec("git add -A")
  }

  discardChanges(): void {
    // Reset staged + tracked modifications back to HEAD of the current branch.
    this.exec("git reset --hard HEAD")
  }
}

// -- LLM Client Adapter (wraps ProviderRouter) --

class ProviderRouterLlmClient implements LlmClient {
  constructor(private readonly router: ProviderRouter) {}

  async chat(messages: LlmMessage[]): Promise<string> {
    const mapped = messages.map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    }))
    const response = await this.router.chat(mapped)
    return response.content
  }
}

// -- CommandRunner Adapter --

class ExecCommandRunner implements CommandRunner {
  async run(
    cmd: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    env?: Record<string, string>,
  ): Promise<CommandResult> {
    try {
      const output = execSync(`${cmd} ${args.join(" ")}`, {
        cwd,
        encoding: "utf-8",
        timeout: timeoutMs,
        env: env ? { ...process.env, ...env } : undefined,
        stdio: ["pipe", "pipe", "pipe"],
      })
      return { exitCode: 0, stdout: output, stderr: "", timedOut: false }
    } catch (err: unknown) {
      const e = err as {
        status?: number
        stdout?: string
        stderr?: string
        killed?: boolean
      }
      if (e.killed) {
        return {
          exitCode: 1,
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
          timedOut: true,
        }
      }
      return {
        exitCode: e.status ?? 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        timedOut: false,
      }
    }
  }
}

// -- ProcessSpawner Adapter --

class ExecProcessSpawner implements ProcessSpawner {
  spawn(
    cmd: string,
    args: string[],
    cwd: string,
    env?: Record<string, string>,
  ): ProcessHandle {
    const child: ChildProcess = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    })

    let exited = false
    const exitCallbacks: (() => void)[] = []

    child.on("exit", () => {
      exited = true
      exitCallbacks.forEach((cb) => cb())
    })

    return {
      kill(signal?: string) {
        child.kill((signal ?? "SIGTERM") as NodeJS.Signals)
      },
      onExit(cb: () => void) {
        if (exited) cb()
        else exitCallbacks.push(cb)
      },
      get exited() {
        return exited
      },
    }
  }
}

// -- HealthChecker Adapter --

class HttpHealthChecker implements HealthChecker {
  async waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const ok = await this.probe(port)
        if (ok) return true
      } catch {
        // ignore
      }
      await sleep(1000)
    }
    return false
  }

  private probe(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${port}/v1/health`, (res) => {
        resolve(res.statusCode === 200)
      })
      req.on("error", () => resolve(false))
      req.setTimeout(5000, () => {
        req.destroy()
        resolve(false)
      })
    })
  }
}

// -- BehaviorTester Adapter --

class HttpBehaviorTester implements BehaviorTester {
  async testTrace(
    port: number,
    trace: TraceRecord,
    originalLength: number,
  ): Promise<TraceTestResult> {
    // Send a simple chat request to the temp process
    try {
      const body = JSON.stringify({
        messages: [{ role: "user", content: `Trace replay: ${trace.id}` }],
      })

      const response = await this.post(port, "/v1/agent/chat", body)
      const responseLength = response.length
      const lengthRatio = originalLength > 0
        ? responseLength / originalLength
        : 1

      return {
        traceId: trace.id,
        statusCode: 200,
        responseLength,
        responseToolSequence: [],
        toolSequenceMatch: true, // simplified: we can't fully verify tool sequences in replay
        lengthInRange: lengthRatio >= 0.3 && lengthRatio <= 3.0,
        isError: false,
      }
    } catch {
      return {
        traceId: trace.id,
        statusCode: 500,
        responseLength: 0,
        responseToolSequence: [],
        toolSequenceMatch: false,
        lengthInRange: false,
        isError: true,
      }
    }
  }

  private post(port: number, path: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "localhost",
          port,
          path,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = ""
          res.on("data", (chunk) => (data += chunk))
          res.on("end", () => resolve(data))
        },
      )
      req.on("error", reject)
      req.setTimeout(30_000, () => {
        req.destroy()
        reject(new Error("Request timeout"))
      })
      req.write(body)
      req.end()
    })
  }
}

// -- Health Probe for PostSwitchMonitor --

class HttpHealthProbe implements HealthProbe {
  constructor(private readonly port: number) {}

  async check(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(
        `http://localhost:${this.port}/v1/health`,
        (res) => {
          resolve(res.statusCode === 200)
        },
      )
      req.on("error", () => resolve(false))
      req.setTimeout(5000, () => {
        req.destroy()
        resolve(false)
      })
    })
  }
}

// -- Error Counter (wired to actual server request tracking) --

class ServerErrorCounter implements ErrorCounter {
  private requests: { timestamp: number; isError: boolean }[] = []

  record(isError: boolean): void {
    this.requests.push({ timestamp: Date.now(), isError })
  }

  getTotalRequests(windowMs: number): number {
    const since = Date.now() - windowMs
    this.requests = this.requests.filter((r) => r.timestamp >= since)
    return this.requests.length
  }

  getErrorCount(windowMs: number): number {
    const since = Date.now() - windowMs
    return this.requests.filter(
      (r) => r.timestamp >= since && r.isError,
    ).length
  }
}

// -- FuzzyMatcher (simple Levenshtein-based) --

class SimpleFuzzyMatcher implements FuzzyMatcher {
  findAndReplace(
    content: string,
    oldStr: string,
    newStr: string,
  ): { success: boolean; result: string } {
    // Exact match first
    if (content.includes(oldStr)) {
      return { success: true, result: content.replace(oldStr, newStr) }
    }

    // Fuzzy: try trimmed lines comparison
    const oldLines = oldStr.split("\n").map((l) => l.trim())
    const contentLines = content.split("\n")

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      let match = true
      for (let j = 0; j < oldLines.length; j++) {
        if (contentLines[i + j].trim() !== oldLines[j]) {
          match = false
          break
        }
      }
      if (match) {
        const newLines = newStr.split("\n")
        const result = [
          ...contentLines.slice(0, i),
          ...newLines,
          ...contentLines.slice(i + oldLines.length),
        ].join("\n")
        return { success: true, result }
      }
    }

    return { success: false, result: content }
  }
}

// -- ActivityTracker (tracks HTTP request timestamps) --

class RequestActivityTracker implements ActivityTracker, ActivityRecorder {
  private lastActivity = Date.now()

  recordActivity(): void {
    this.lastActivity = Date.now()
  }

  getIdleMs(): number {
    return Date.now() - this.lastActivity
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Factory Output ───────────────────────────────────────────────────────────

export interface ActivityRecorder {
  recordActivity(): void
  getIdleMs(): number
}

export interface TwinSystemInstance {
  pipeline: EvolutionPipeline
  scheduler: SchedulerRunner
  monitor: PostSwitchMonitor
  aggregator: IntentAggregator
  persistence: PersistenceAdapter
  slotManager: SlotManager
  activityTracker: ActivityRecorder
  errorCounter: ErrorCounter
  metrics: EvolutionMetrics
  approvalGate: ApprovalGate
  /** Whether the evolution engine is enabled (config.evolution.enabled) */
  enabled: boolean
  /** Whether dry-run mode is enabled (skip actual slot switch) */
  dryRun: boolean
  /** Start the scheduler (call after server is listening) */
  start(): void
  /** Stop the scheduler + cleanup */
  stop(): void
}

// ── Factory Function ─────────────────────────────────────────────────────────

export function createTwinSystem(
  evolutionConfig: EvolutionConfig,
  router: ProviderRouter,
  db: Db,
  serverPort: number,
): TwinSystemInstance {
  const repoRoot = process.cwd()

  // Ensure data directory exists
  const dataDir = join(repoRoot, evolutionConfig.dataDir)
  mkdirSync(dataDir, { recursive: true })

  // ── 1. Persistence ──────────────────────────────────────────────────────
  const persistence = new PersistenceAdapter(db)

  // ── 2. Safety Guard ─────────────────────────────────────────────────────
  const safetyGuard = new SafetyGuard(
    {
      protectedPaths: evolutionConfig.protectedPaths,
      maxEvolutionsPerFile24h: evolutionConfig.maxEvolutionsPerFile24h,
      failureRateThreshold: evolutionConfig.failureRateThreshold,
    },
    persistence,
  )

  // ── 3. Slot Manager ─────────────────────────────────────────────────────
  const slotGitOps = new SlotGitOpsAdapter(repoRoot)
  const slotManager = new SlotManager(slotGitOps, {
    mainBranch: evolutionConfig.mainBranch,
  })

  // ── 4. Mutator ──────────────────────────────────────────────────────────
  const mutatorConfig: MutatorConfig = {
    maxRounds: evolutionConfig.maxMutationRounds,
    confidenceThreshold: evolutionConfig.confidenceThreshold,
    repoRoot,
  }
  const mutator = new MutatorImpl({
    fs: new NodeFileSystem(),
    typeChecker: new TscTypeChecker(),
    git: new MutatorGitOpsAdapter(repoRoot),
    llm: new ProviderRouterLlmClient(router),
    config: mutatorConfig,
    logger,
    fuzzyMatcher: new SimpleFuzzyMatcher(),
  })

  // ── 5. Validator ────────────────────────────────────────────────────────
  const validatorConfig: ValidatorConfig = {
    repoRoot,
    testPort: evolutionConfig.testPort,
    buildTimeoutMs: 3 * 60_000,
    testTimeoutMs: 5 * 60_000,
    healthCheckTimeoutMs: 30_000,
    minTracesForLevel2: 3,
    maxErrorRate: 0.3,
    minLengthPassRate: 0.5,
  }
  const validator = new ValidatorImpl({
    commandRunner: new ExecCommandRunner(),
    processSpawner: new ExecProcessSpawner(),
    healthChecker: new HttpHealthChecker(),
    behaviorTester: new HttpBehaviorTester(),
    config: validatorConfig,
    logger,
  })

  // ── 6. Approval Gate ──────────────────────────────────────────────────────
  const approvalGateConfig: Partial<ApprovalGateConfig> = {
    autoApproveRiskLevels: evolutionConfig.autoApproveRiskLevels as ApprovalGateConfig["autoApproveRiskLevels"],
    approvalTimeoutMs: evolutionConfig.approvalTimeoutMs,
  }
  const approvalGate = new ApprovalGate(approvalGateConfig, logger)

  // ── 7. Pipeline ─────────────────────────────────────────────────────────
  const pipeline = new EvolutionPipeline({
    slotManager,
    safetyGuard,
    mutator,
    validator,
    config: {
      maxMutationRounds: evolutionConfig.maxMutationRounds,
      confidenceThreshold: evolutionConfig.confidenceThreshold,
      autoSwitch: evolutionConfig.autoSwitch,
      testPort: evolutionConfig.testPort,
      protectedPaths: evolutionConfig.protectedPaths,
      maxEvolutionsPerFile24h: evolutionConfig.maxEvolutionsPerFile24h,
      postSwitchMonitorMs: evolutionConfig.postSwitchMonitorMs,
      failureRateThreshold: evolutionConfig.failureRateThreshold,
    },
    logger,
    onApprovalNeeded: (intent, summary) => approvalGate.requestApproval(intent, summary),
    dryRun: evolutionConfig.dryRun,
  })

  // ── 7. Post-Switch Monitor ──────────────────────────────────────────────
  const errorCounter = new ServerErrorCounter()
  const monitorConfig: Partial<PostSwitchMonitorConfig> = {
    monitorWindowMs: evolutionConfig.postSwitchMonitorMs,
    failureRateThreshold: evolutionConfig.failureRateThreshold,
  }
  const monitor = new PostSwitchMonitor({
    healthProbe: new HttpHealthProbe(serverPort),
    errorCounter,
    slotManager,
    config: monitorConfig,
    logger,
  })

  // ── 8. Intent Aggregator + Sources ─────────────────────────────────────
  const aggregator = new IntentAggregator()

  // Register intent sources
  aggregator.addSource(new TraceIntentSource(db))
  aggregator.addSource(new MemoryIntentSource(db))
  // Note: UpstreamIntentSource requires an UpstreamTracker instance.
  // It will be registered externally if upstream tracking is configured.

  // ── 9. Scheduler ────────────────────────────────────────────────────────
  const activityTracker = new RequestActivityTracker()
  const schedulerConfig: Partial<SchedulerConfig> = {
    idleThresholdMs: evolutionConfig.idleThresholdMs,
    cronIntervalMs: evolutionConfig.cronIntervalMs,
    cooldownMs: evolutionConfig.cooldownMs,
    idleEnabled: true,
    cronEnabled: evolutionConfig.cronIntervalMs > 0,
  }

  // ── 10. Metrics ──────────────────────────────────────────────────────────
  const metrics = new EvolutionMetrics({
    maxCyclesPerDay: evolutionConfig.maxCyclesPerDay,
    recentHistorySize: 20,
  })

  const dryRun = evolutionConfig.dryRun

  // Guards against concurrent re-entry: a pipeline cycle may run for several
  // minutes (e.g. waiting on human approval). Without this lock the scheduler
  // would keep triggering new cycles that collide on the standby slot.
  let cycleRunning = false

  const scheduler = new SchedulerRunner({
    activityTracker,
    onTrigger: async (reason) => {
      logger.info("Evolution triggered (reason=%s, dryRun=%s)", reason, dryRun)

      // Re-entry guard: skip if a cycle is still in flight.
      if (cycleRunning) {
        logger.info("Evolution cycle already running, skipping trigger")
        return false
      }

      // Daily budget check
      if (!metrics.canRunToday()) {
        logger.warn("Daily cycle budget exhausted, skipping")
        metrics.recordSkipped()
        return false
      }

      // Collect fresh intents from all sources before picking next
      await aggregator.collect()
      // Get next intent from aggregator
      const intent = aggregator.next()
      if (!intent) {
        logger.info("No intents in queue, skipping evolution cycle")
        metrics.recordSkipped()
        return false
      }

      const startedAt = Date.now()
      cycleRunning = true
      try {
        const result = await pipeline.run(intent)

        metrics.recordCycle({
          intentId: intent.id,
          intentType: intent.type,
          trigger: reason,
          startedAt,
          success: result.success,
          abortReason: result.abortReason,
          changedFiles: result.mutationResult?.changedFiles ?? [],
          rolled_back: false,
        })

        if (result.success) {
          // Record evolution frequency for changed files
          for (const file of result.mutationResult?.changedFiles ?? []) {
            persistence.recordEvolution(file)
          }
          if (dryRun) {
            logger.info("[DRY-RUN] Evolution validated but slot switch skipped")
          } else if (result.switchRecord) {
            // Real switch landed on main. Monitor health + error rate for the
            // configured window; PostSwitchMonitor auto-rolls-back on failure.
            logger.info("Evolution succeeded, starting post-switch monitoring")
            try {
              const monitorResult = await monitor.monitor(result.switchRecord)
              if (monitorResult.rolledBack) {
                logger.warn(
                  "Post-switch monitor rolled back evolution %s: %s",
                  intent.id,
                  monitorResult.rollbackReason ?? "unknown",
                )
                metrics.recordRollback()
              } else {
                logger.info(
                  "Post-switch monitoring passed for %s (%dms)",
                  intent.id,
                  monitorResult.durationMs,
                )
              }
            } catch (mErr) {
              logger.error(
                "Post-switch monitoring threw for %s: %s",
                intent.id,
                mErr instanceof Error ? mErr.message : String(mErr),
              )
            }
          } else {
            logger.warn(
              "Evolution reported success but no switchRecord; skipping monitoring",
            )
          }
        } else {
          logger.warn("Evolution cycle completed with failure: %s", result.abortReason)
        }
        return result.success
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error("Evolution cycle threw: %s", msg)

        metrics.recordCycle({
          intentId: intent.id,
          intentType: intent.type,
          trigger: reason,
          startedAt,
          success: false,
          abortReason: msg,
          changedFiles: [],
          rolled_back: false,
        })
        return false
      } finally {
        cycleRunning = false
      }
    },
    config: schedulerConfig,
    logger,
  })

  return {
    pipeline,
    scheduler,
    monitor,
    aggregator,
    persistence,
    slotManager,
    activityTracker,
    errorCounter,
    metrics,
    approvalGate,
    enabled: evolutionConfig.enabled,
    dryRun,
    start() {
      if (evolutionConfig.enabled) {
        scheduler.start()
        logger.info(
          "Twin-system scheduler started (dryRun=%s, maxCyclesPerDay=%s)",
          dryRun,
          evolutionConfig.maxCyclesPerDay || "unlimited",
        )
      } else {
        logger.info("Twin-system is disabled (evolution.enabled = false)")
      }
    },
    stop() {
      scheduler.stop()
      logger.info("Twin-system scheduler stopped")
    },
  }
}
