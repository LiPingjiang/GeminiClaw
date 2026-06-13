/**
 * Subagent Registry — 子任务注册表
 *
 * 跟踪所有正在运行的异步子任务。提供注册、完成、查询接口。
 * 内置 sweeper 定期清理超时的 run（防止内存泄漏）。
 *
 * 参考 OpenClaw 的 subagent-registry-run-manager.ts，但大幅简化：
 * 我们是单进程模型，不需要跨进程 RPC 等待。
 */

import { emitLifecycle } from "./lifecycle-bus.js"

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface SubagentRunRecord {
  runId: string
  parentSessionId: string
  parentAgentId: string | null
  /** 父会话的用户 ID（用于 QQ 渠道推送） */
  parentUserId?: string
  childSessionKey: string
  /** 任务描述 */
  task: string
  /** 任务标题列表 */
  taskTitles: string[]
  status: "running" | "completed" | "failed" | "aborted"
  startedAt: number
  completedAt?: number
  result?: string
  error?: string
}

// ── 单例状态 ──────────────────────────────────────────────────────────────────

const runs = new Map<string, SubagentRunRecord>()

/** Sweeper interval handle */
let sweeperHandle: ReturnType<typeof setInterval> | null = null

/** Max run duration before auto-abort (10 minutes) */
const MAX_RUN_DURATION_MS = 10 * 60 * 1000

/** Sweeper interval (30 seconds) */
const SWEEPER_INTERVAL_MS = 30_000

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * 注册一个新的子任务 run。
 */
export function registerRun(record: SubagentRunRecord): void {
  runs.set(record.runId, record)
  ensureSweeper()
  console.log(
    `[SubagentRegistry] registered run=${record.runId}, tasks=[${record.taskTitles.join(", ")}], parent=${record.parentSessionId.slice(0, 12)}…`,
  )
}

/**
 * 标记 run 完成（成功）。
 */
export function completeRun(runId: string, result: string): void {
  const record = runs.get(runId)
  if (!record) return
  record.status = "completed"
  record.completedAt = Date.now()
  record.result = result

  emitLifecycle({
    runId,
    phase: "end",
    sessionKey: record.childSessionKey,
    parentSessionId: record.parentSessionId,
    parentAgentId: record.parentAgentId,
    taskDescription: record.task,
    result,
  })

  console.log(
    `[SubagentRegistry] completed run=${runId}, duration=${record.completedAt - record.startedAt}ms`,
  )

  // 保留记录 5 分钟后清理（供查询）
  setTimeout(() => runs.delete(runId), 5 * 60 * 1000)
}

/**
 * 标记 run 失败。
 */
export function failRun(runId: string, error: string): void {
  const record = runs.get(runId)
  if (!record) return
  record.status = "failed"
  record.completedAt = Date.now()
  record.error = error

  emitLifecycle({
    runId,
    phase: "error",
    sessionKey: record.childSessionKey,
    parentSessionId: record.parentSessionId,
    parentAgentId: record.parentAgentId,
    taskDescription: record.task,
    error,
  })

  console.log(`[SubagentRegistry] failed run=${runId}, error=${error}`)
  setTimeout(() => runs.delete(runId), 5 * 60 * 1000)
}

/**
 * 标记 run 被中止（超时或手动取消）。
 */
export function abortRun(runId: string, reason: string): void {
  const record = runs.get(runId)
  if (!record || record.status !== "running") return
  record.status = "aborted"
  record.completedAt = Date.now()
  record.error = reason

  emitLifecycle({
    runId,
    phase: "aborted",
    sessionKey: record.childSessionKey,
    parentSessionId: record.parentSessionId,
    parentAgentId: record.parentAgentId,
    taskDescription: record.task,
    error: reason,
  })

  console.log(`[SubagentRegistry] aborted run=${runId}, reason=${reason}`)
  setTimeout(() => runs.delete(runId), 5 * 60 * 1000)
}

/**
 * 查询某个 parent session 下所有正在运行的子任务。
 */
export function getRunningForParent(parentSessionId: string): SubagentRunRecord[] {
  return [...runs.values()].filter(
    (r) => r.parentSessionId === parentSessionId && r.status === "running",
  )
}

/**
 * 查询某个 parent session 下所有子任务（含已完成）。
 */
export function getAllForParent(parentSessionId: string): SubagentRunRecord[] {
  return [...runs.values()].filter((r) => r.parentSessionId === parentSessionId)
}

/**
 * 按 runId 查询。
 */
export function getRun(runId: string): SubagentRunRecord | undefined {
  return runs.get(runId)
}

/**
 * 当前活跃 run 数量。
 */
export function activeRunCount(): number {
  return [...runs.values()].filter((r) => r.status === "running").length
}

// ── Sweeper ──────────────────────────────────────────────────────────────────

function ensureSweeper(): void {
  if (sweeperHandle) return
  sweeperHandle = setInterval(() => {
    const now = Date.now()
    for (const [runId, record] of runs) {
      if (record.status === "running" && now - record.startedAt > MAX_RUN_DURATION_MS) {
        abortRun(runId, `timeout: exceeded ${MAX_RUN_DURATION_MS / 1000}s`)
      }
    }
    // Stop sweeper if no active runs
    if (activeRunCount() === 0 && sweeperHandle) {
      clearInterval(sweeperHandle)
      sweeperHandle = null
    }
  }, SWEEPER_INTERVAL_MS)
  // Don't prevent process exit
  if (sweeperHandle && typeof sweeperHandle === "object" && "unref" in sweeperHandle) {
    sweeperHandle.unref()
  }
}

/** Test helper: clear all state */
export function __resetSubagentRegistry(): void {
  runs.clear()
  if (sweeperHandle) {
    clearInterval(sweeperHandle)
    sweeperHandle = null
  }
}
