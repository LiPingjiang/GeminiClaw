/**
 * TaskDelegator — Breaks down a complex task into sub-tasks and manages delegation.
 *
 * Responsibilities:
 * - Create sub-tasks from a parent task description
 * - Assign priorities and dependencies
 * - Track task lifecycle
 * - Aggregate results from completed sub-tasks
 */

import { randomUUID } from "crypto"
import type {
  SubTask,
  TaskResult,
  TaskPriority,
  TaskStatus,
  ContextMode,
  Artifact,
  ExecutionMetrics,
} from "./types.js"

export interface TaskSpec {
  title: string
  description: string
  priority?: TaskPriority
  allowedTools?: string[]
  maxTurns?: number
  allowedPaths?: string[]
  dependsOn?: string[]
  /** Context propagation mode. Default: "isolated" */
  contextMode?: ContextMode
}

export interface DelegatorConfig {
  /** Default max turns for sub-tasks */
  defaultMaxTurns?: number
  /** Default priority for sub-tasks */
  defaultPriority?: TaskPriority
}

export class TaskDelegator {
  private tasks: Map<string, SubTask> = new Map()
  private config: Required<DelegatorConfig>

  constructor(config: DelegatorConfig = {}) {
    this.config = {
      defaultMaxTurns: config.defaultMaxTurns ?? 8,
      defaultPriority: config.defaultPriority ?? "normal",
    }
  }

  /**
   * Create a sub-task from a specification.
   */
  createTask(spec: TaskSpec, parentId: string | null = null): SubTask {
    const id = `task_${randomUUID().slice(0, 12)}`
    const now = Date.now()

    const task: SubTask = {
      id,
      title: spec.title,
      description: spec.description,
      priority: spec.priority ?? this.config.defaultPriority,
      status: "pending",
      parentId,
      allowedTools: spec.allowedTools ?? [],
      maxTurns: spec.maxTurns ?? this.config.defaultMaxTurns,
      allowedPaths: spec.allowedPaths ?? [],
      dependsOn: spec.dependsOn ?? [],
      contextMode: spec.contextMode ?? "isolated",
      createdAt: now,
      updatedAt: now,
    }

    this.tasks.set(id, task)
    return task
  }

  /**
   * Create multiple sub-tasks at once.
   */
  createTasks(
    specs: TaskSpec[],
    parentId: string | null = null,
  ): SubTask[] {
    return specs.map((spec) => this.createTask(spec, parentId))
  }

  /**
   * Get a task by ID.
   */
  getTask(id: string): SubTask | undefined {
    return this.tasks.get(id)
  }

  /**
   * Get all tasks.
   */
  getAllTasks(): SubTask[] {
    return Array.from(this.tasks.values())
  }

  /**
   * Update task status.
   */
  updateStatus(id: string, status: TaskStatus): boolean {
    const task = this.tasks.get(id)
    if (!task) return false
    task.status = status
    task.updatedAt = Date.now()
    return true
  }

  /**
   * Mark a task as running with an assigned agent.
   */
  assignToAgent(taskId: string, agentId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false
    task.assignedAgentId = agentId
    task.status = "running"
    task.updatedAt = Date.now()
    return true
  }

  /**
   * Record the result of a completed task.
   */
  recordResult(taskId: string, result: TaskResult): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false
    task.result = result
    task.status = result.success ? "completed" : "failed"
    task.updatedAt = Date.now()
    return true
  }

  /**
   * Cancel a task.
   */
  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false
    if (task.status === "completed" || task.status === "failed") return false
    task.status = "cancelled"
    task.updatedAt = Date.now()
    return true
  }

  /**
   * Get tasks that are ready to run (all dependencies satisfied).
   */
  getReadyTasks(): SubTask[] {
    return Array.from(this.tasks.values()).filter((task) => {
      if (task.status !== "pending") return false
      return this.areDependenciesMet(task)
    })
  }

  /**
   * Check if all dependencies of a task are completed.
   */
  areDependenciesMet(task: SubTask): boolean {
    if (task.dependsOn.length === 0) return true
    return task.dependsOn.every((depId) => {
      const dep = this.tasks.get(depId)
      return dep?.status === "completed"
    })
  }

  /**
   * Check if all tasks are in a terminal state.
   */
  isAllDone(): boolean {
    return Array.from(this.tasks.values()).every(
      (t) =>
        t.status === "completed" ||
        t.status === "failed" ||
        t.status === "cancelled",
    )
  }

  /**
   * Aggregate results from all completed tasks into a summary.
   */
  aggregateResults(): {
    summary: string
    allArtifacts: Artifact[]
    metrics: ExecutionMetrics
    successRate: number
  } {
    const completed = Array.from(this.tasks.values()).filter(
      (t) => t.status === "completed" && t.result,
    )
    const failed = Array.from(this.tasks.values()).filter(
      (t) => t.status === "failed",
    )
    const total = this.tasks.size

    const allArtifacts: Artifact[] = []
    let totalTurns = 0
    let totalToolCalls = 0
    let totalDurationMs = 0

    const outputSections: string[] = []

    for (const task of completed) {
      if (task.result) {
        allArtifacts.push(...task.result.artifacts)
        totalTurns += task.result.metrics.turnsUsed
        totalToolCalls += task.result.metrics.toolCallCount
        totalDurationMs += task.result.metrics.durationMs
        outputSections.push(`### ${task.title}\n${task.result.output}`)
      }
    }

    for (const task of failed) {
      outputSections.push(
        `### ${task.title} [FAILED]\n${task.result?.output ?? "Unknown error"}`,
      )
    }

    const successRate = total > 0 ? completed.length / total : 0
    const summary = [
      `## Task Delegation Results`,
      ``,
      `Completed: ${completed.length}/${total} | Failed: ${failed.length} | Success Rate: ${(successRate * 100).toFixed(0)}%`,
      ``,
      ...outputSections,
    ].join("\n")

    return {
      summary,
      allArtifacts,
      metrics: {
        turnsUsed: totalTurns,
        toolCallCount: totalToolCalls,
        durationMs: totalDurationMs,
      },
      successRate,
    }
  }

  /**
   * Get tasks sorted by priority (critical > high > normal > low).
   */
  getTasksByPriority(): SubTask[] {
    const priorityOrder: Record<TaskPriority, number> = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3,
    }
    return Array.from(this.tasks.values()).sort(
      (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority],
    )
  }

  /**
   * Reset: clear all tasks (for reuse).
   */
  reset(): void {
    this.tasks.clear()
  }

  get size(): number {
    return this.tasks.size
  }
}
