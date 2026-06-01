/**
 * Orchestrator — Coordinates execution of multiple sub-agents.
 *
 * Supports three execution strategies:
 * - parallel: Run all independent tasks concurrently
 * - sequential: Run tasks one by one in order
 * - dependency_graph: Respect task dependencies, parallelize where possible
 *
 * Features:
 * - Concurrency control (maxConcurrent from boundary)
 * - Fail-fast mode (abort remaining on first failure)
 * - Timeout enforcement at plan level
 * - Event emission for monitoring
 */

import { randomUUID } from "crypto"
import type {
  SubTask,
  OrchestrationPlan,
  OrchestrationResult,
  ContextBoundary,
  ExecutionStrategy,
  MultiAgentEvent,
  TaskResult,
} from "./types.js"
import { TaskDelegator, type TaskSpec } from "./task-delegator.js"
import { SubAgentRunner, type SubAgentRunnerConfig } from "./sub-agent-runner.js"
import { createBoundary, deriveChildBoundary } from "./context-boundary.js"
import type { ChatFn } from "../agent/loop.js"
import type { ToolRegistryLike } from "../agent/loop.js"

export interface OrchestratorConfig {
  chatFn: ChatFn
  toolRegistry: ToolRegistryLike
  /** Default boundary for sub-agents */
  boundary?: Partial<ContextBoundary>
  /** Default execution strategy */
  strategy?: ExecutionStrategy
  /** Global timeout for the entire orchestration (ms) */
  timeoutMs?: number
  /** Abort all tasks on first failure */
  failFast?: boolean
  /** System prompt template for sub-agents */
  systemPrompt?: string
  /** Logger */
  logger?: {
    info(msg: string, ...args: unknown[]): void
    warn(msg: string, ...args: unknown[]): void
    error(msg: string, ...args: unknown[]): void
  }
}

export class Orchestrator {
  private config: OrchestratorConfig
  private events: MultiAgentEvent[] = []
  private boundary: ContextBoundary

  constructor(config: OrchestratorConfig) {
    this.config = config
    this.boundary = createBoundary(config.boundary ?? {})
  }

  /**
   * Execute an orchestration plan.
   */
  async execute(
    taskSpecs: TaskSpec[],
    options: {
      strategy?: ExecutionStrategy
      parentContext?: string
      signal?: AbortSignal
    } = {},
  ): Promise<OrchestrationResult> {
    const planId = `plan_${randomUUID().slice(0, 8)}`
    const startMs = Date.now()
    const strategy = options.strategy ?? this.config.strategy ?? "dependency_graph"

    // Create the delegator and tasks
    const delegator = new TaskDelegator()
    const tasks = delegator.createTasks(taskSpecs)

    this.log(`[Orchestrator] Plan ${planId}: ${tasks.length} tasks, strategy=${strategy}`)

    // Create plan object
    const plan: OrchestrationPlan = {
      id: planId,
      strategy,
      tasks,
      boundary: this.boundary,
      timeoutMs: this.config.timeoutMs ?? 300000, // 5 min default
      failFast: this.config.failFast ?? false,
      createdAt: Date.now(),
    }

    // Execute based on strategy
    let result: OrchestrationResult
    try {
      switch (strategy) {
        case "parallel":
          result = await this.executeParallel(plan, delegator, options)
          break
        case "sequential":
          result = await this.executeSequential(plan, delegator, options)
          break
        case "dependency_graph":
          result = await this.executeDependencyGraph(plan, delegator, options)
          break
        default:
          throw new Error(`Unknown strategy: ${strategy}`)
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      result = {
        planId,
        status: "failed",
        tasks: delegator.getAllTasks(),
        summary: `Orchestration failed: ${errorMsg}`,
        metrics: {
          totalDurationMs: Date.now() - startMs,
          tasksCompleted: 0,
          tasksFailed: delegator.getAllTasks().length,
          tasksCancelled: 0,
        },
      }
    }

    this.emit({ type: "orchestration_complete", result })
    return result
  }

  /** Get all events from the orchestration */
  getEvents(): MultiAgentEvent[] {
    return [...this.events]
  }

  // ── Execution Strategies ─────────────────────────────────────────────────

  private async executeParallel(
    plan: OrchestrationPlan,
    delegator: TaskDelegator,
    options: { parentContext?: string; signal?: AbortSignal },
  ): Promise<OrchestrationResult> {
    const startMs = Date.now()
    const tasks = delegator.getAllTasks()
    const maxConcurrent = this.boundary.maxConcurrent

    // Run in batches respecting concurrency limit
    const results: Map<string, TaskResult> = new Map()
    for (let i = 0; i < tasks.length; i += maxConcurrent) {
      const batch = tasks.slice(i, i + maxConcurrent)
      const batchResults = await Promise.allSettled(
        batch.map((task) => this.runSingleTask(task, delegator, options)),
      )

      for (let j = 0; j < batchResults.length; j++) {
        const br = batchResults[j]
        const task = batch[j]
        if (br.status === "fulfilled") {
          results.set(task.id, br.value)
          delegator.recordResult(task.id, br.value)
        } else {
          const failResult: TaskResult = {
            success: false,
            output: br.reason?.message ?? "Unknown error",
            artifacts: [],
            metrics: { turnsUsed: 0, toolCallCount: 0, durationMs: 0 },
          }
          results.set(task.id, failResult)
          delegator.recordResult(task.id, failResult)
        }

        // Fail-fast check
        if (this.config.failFast && !results.get(task.id)?.success) {
          // Cancel remaining
          for (const remaining of tasks.slice(i + maxConcurrent)) {
            delegator.cancelTask(remaining.id)
          }
          break
        }
      }
    }

    return this.buildResult(plan.id, delegator, startMs)
  }

  private async executeSequential(
    plan: OrchestrationPlan,
    delegator: TaskDelegator,
    options: { parentContext?: string; signal?: AbortSignal },
  ): Promise<OrchestrationResult> {
    const startMs = Date.now()
    const tasks = delegator.getTasksByPriority()

    for (const task of tasks) {
      if (options.signal?.aborted) {
        delegator.cancelTask(task.id)
        continue
      }

      try {
        const result = await this.runSingleTask(task, delegator, options)
        delegator.recordResult(task.id, result)

        if (this.config.failFast && !result.success) {
          // Cancel remaining
          for (const remaining of tasks) {
            if (remaining.status === "pending") {
              delegator.cancelTask(remaining.id)
            }
          }
          break
        }
      } catch (err) {
        const failResult: TaskResult = {
          success: false,
          output: err instanceof Error ? err.message : String(err),
          artifacts: [],
          metrics: { turnsUsed: 0, toolCallCount: 0, durationMs: 0 },
        }
        delegator.recordResult(task.id, failResult)
        if (this.config.failFast) break
      }
    }

    return this.buildResult(plan.id, delegator, startMs)
  }

  private async executeDependencyGraph(
    plan: OrchestrationPlan,
    delegator: TaskDelegator,
    options: { parentContext?: string; signal?: AbortSignal },
  ): Promise<OrchestrationResult> {
    const startMs = Date.now()
    const maxConcurrent = this.boundary.maxConcurrent

    while (!delegator.isAllDone()) {
      if (options.signal?.aborted) {
        // Cancel all pending tasks
        for (const task of delegator.getAllTasks()) {
          if (task.status === "pending") delegator.cancelTask(task.id)
        }
        break
      }

      const ready = delegator.getReadyTasks()
      if (ready.length === 0) {
        // Check for deadlock: no ready tasks but not all done
        const pending = delegator.getAllTasks().filter((t) => t.status === "pending")
        if (pending.length > 0) {
          // Deadlock: dependencies can never be met
          for (const task of pending) {
            delegator.cancelTask(task.id)
          }
          this.log("[Orchestrator] Deadlock detected, cancelling pending tasks")
        }
        break
      }

      // Run ready tasks with concurrency limit
      const batch = ready.slice(0, maxConcurrent)
      const batchResults = await Promise.allSettled(
        batch.map((task) => this.runSingleTask(task, delegator, options)),
      )

      for (let i = 0; i < batchResults.length; i++) {
        const br = batchResults[i]
        const task = batch[i]
        if (br.status === "fulfilled") {
          delegator.recordResult(task.id, br.value)
        } else {
          const failResult: TaskResult = {
            success: false,
            output: br.reason?.message ?? "Unknown error",
            artifacts: [],
            metrics: { turnsUsed: 0, toolCallCount: 0, durationMs: 0 },
          }
          delegator.recordResult(task.id, failResult)
        }

        if (this.config.failFast && !delegator.getTask(task.id)?.result?.success) {
          for (const t of delegator.getAllTasks()) {
            if (t.status === "pending") delegator.cancelTask(t.id)
          }
          break
        }
      }
    }

    return this.buildResult(plan.id, delegator, startMs)
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async runSingleTask(
    task: SubTask,
    delegator: TaskDelegator,
    options: { parentContext?: string; signal?: AbortSignal },
  ): Promise<TaskResult> {
    delegator.updateStatus(task.id, "running")

    // Derive child boundary
    const childBoundary = deriveChildBoundary(this.boundary, {
      allowedTools: task.allowedTools.length > 0 ? task.allowedTools : undefined,
      allowedPaths: task.allowedPaths.length > 0 ? task.allowedPaths : undefined,
    })

    const runner = new SubAgentRunner({
      chatFn: this.config.chatFn,
      toolRegistry: this.config.toolRegistry,
      boundary: childBoundary,
      systemPrompt: this.config.systemPrompt,
      timeoutMs: this.config.timeoutMs,
      logger: this.config.logger,
    })

    const result = await runner.run(task, {
      parentContext: options.parentContext,
      signal: options.signal,
    })

    // Collect runner events
    this.events.push(...runner.getEvents())

    return result
  }

  private buildResult(
    planId: string,
    delegator: TaskDelegator,
    startMs: number,
  ): OrchestrationResult {
    const allTasks = delegator.getAllTasks()
    const { summary } = delegator.aggregateResults()

    const completed = allTasks.filter((t) => t.status === "completed").length
    const failed = allTasks.filter((t) => t.status === "failed").length
    const cancelled = allTasks.filter((t) => t.status === "cancelled").length

    let status: "completed" | "partial" | "failed"
    if (failed === 0 && cancelled === 0) {
      status = "completed"
    } else if (completed > 0) {
      status = "partial"
    } else {
      status = "failed"
    }

    return {
      planId,
      status,
      tasks: allTasks,
      summary,
      metrics: {
        totalDurationMs: Date.now() - startMs,
        tasksCompleted: completed,
        tasksFailed: failed,
        tasksCancelled: cancelled,
      },
    }
  }

  private emit(event: MultiAgentEvent): void {
    this.events.push(event)
  }

  private log(msg: string): void {
    this.config.logger?.info(msg)
  }
}
