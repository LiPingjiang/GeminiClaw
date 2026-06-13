/**
 * Subagent Registry — 子任务注册表
 *
 * 跟踪所有正在运行的异步子任务。提供注册、完成、查询接口。
 * 内置 sweeper 定期清理超时的 run（防止内存泄漏）。
 *
 * v2: 支持 SQLite 持久化，重启后可恢复历史记录。
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

// ── DB interface (subset of better-sqlite3) ──────────────────────────────────

interface DbLike {
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
  exec(sql: string): void
}

// ── 单例状态 ──────────────────────────────────────────────────────────────────

const runs = new Map<string, SubagentRunRecord>()

/** Sweeper interval handle */
let sweeperHandle: ReturnType<typeof setInterval> | null = null

/** Max run duration before auto-abort (10 minutes) */
const MAX_RUN_DURATION_MS = 10 * 60 * 1000

/** Sweeper interval (30 seconds) */
const SWEEPER_INTERVAL_MS = 30_000

/** SQLite database reference (set via initRegistry) */
let _db: DbLike | null = null

/** How long to keep completed records in memory (5 minutes) */
const MEMORY_RETENTION_MS = 5 * 60 * 1000

// ── Persistence Layer ─────────────────────────────────────────────────────────

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS subagent_runs (
  run_id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  parent_agent_id TEXT,
  parent_user_id TEXT,
  child_session_key TEXT NOT NULL,
  task TEXT NOT NULL,
  task_titles TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  result TEXT,
  error TEXT
)`

const CREATE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent
  ON subagent_runs(parent_session_id, status)`

function persistInsert(record: SubagentRunRecord): void {
  if (!_db) return
  try {
    _db.prepare(`
      INSERT OR REPLACE INTO subagent_runs
        (run_id, parent_session_id, parent_agent_id, parent_user_id,
         child_session_key, task, task_titles, status, started_at,
         completed_at, result, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.runId,
      record.parentSessionId,
      record.parentAgentId,
      record.parentUserId ?? null,
      record.childSessionKey,
      record.task,
      JSON.stringify(record.taskTitles),
      record.status,
      record.startedAt,
      record.completedAt ?? null,
      record.result ?? null,
      record.error ?? null,
    )
  } catch (err) {
    console.error("[SubagentRegistry] persist insert failed:", err)
  }
}

function persistUpdate(record: SubagentRunRecord): void {
  if (!_db) return
  try {
    _db.prepare(`
      UPDATE subagent_runs
      SET status = ?, completed_at = ?, result = ?, error = ?
      WHERE run_id = ?
    `).run(
      record.status,
      record.completedAt ?? null,
      record.result ?? null,
      record.error ?? null,
      record.runId,
    )
  } catch (err) {
    console.error("[SubagentRegistry] persist update failed:", err)
  }
}

function loadFromDb(): void {
  if (!_db) return
  try {
    // Load recent records (last 24 hours) to avoid unbounded growth
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    const rows = _db.prepare(`
      SELECT * FROM subagent_runs WHERE started_at > ?
      ORDER BY started_at DESC
    `).all(cutoff) as Array<Record<string, unknown>>

    for (const row of rows) {
      const record: SubagentRunRecord = {
        runId: row.run_id as string,
        parentSessionId: row.parent_session_id as string,
        parentAgentId: (row.parent_agent_id as string) || null,
        parentUserId: (row.parent_user_id as string) || undefined,
        childSessionKey: row.child_session_key as string,
        task: row.task as string,
        taskTitles: JSON.parse(row.task_titles as string),
        status: row.status as SubagentRunRecord["status"],
        startedAt: row.started_at as number,
        completedAt: (row.completed_at as number) || undefined,
        result: (row.result as string) || undefined,
        error: (row.error as string) || undefined,
      }
      runs.set(record.runId, record)
    }

    // Mark any "running" records from before restart as aborted
    let abortedCount = 0
    for (const record of runs.values()) {
      if (record.status === "running") {
        record.status = "aborted"
        record.completedAt = Date.now()
        record.error = "server restarted"
        persistUpdate(record)
        abortedCount++
      }
    }

    console.log(
      `[SubagentRegistry] loaded ${rows.length} records from DB` +
        (abortedCount > 0 ? `, aborted ${abortedCount} stale runs` : ""),
    )
  } catch (err) {
    console.error("[SubagentRegistry] loadFromDb failed:", err)
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize the registry with a database connection.
 * Creates the table if needed and loads existing records.
 * Call once at startup.
 */
export function initRegistry(db: DbLike): void {
  _db = db
  try {
    db.exec(CREATE_TABLE_SQL)
    db.exec(CREATE_INDEX_SQL)
  } catch (err) {
    console.error("[SubagentRegistry] table creation failed:", err)
  }
  loadFromDb()
}

/**
 * 注册一个新的子任务 run。
 */
export function registerRun(record: SubagentRunRecord): void {
  runs.set(record.runId, record)
  persistInsert(record)
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

  persistUpdate(record)

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

  // 保留记录一段时间后从内存清理（DB 中保留）
  setTimeout(() => runs.delete(runId), MEMORY_RETENTION_MS)
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

  persistUpdate(record)

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
  setTimeout(() => runs.delete(runId), MEMORY_RETENTION_MS)
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

  persistUpdate(record)

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
  setTimeout(() => runs.delete(runId), MEMORY_RETENTION_MS)
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
 * If records have been evicted from memory, falls back to DB.
 */
export function getAllForParent(parentSessionId: string): SubagentRunRecord[] {
  // First check in-memory
  const inMemory = [...runs.values()].filter((r) => r.parentSessionId === parentSessionId)
  if (inMemory.length > 0) return inMemory

  // Fallback: query DB for historical records
  if (!_db) return []
  try {
    const rows = _db.prepare(`
      SELECT * FROM subagent_runs
      WHERE parent_session_id = ?
      ORDER BY started_at DESC
      LIMIT 50
    `).all(parentSessionId) as Array<Record<string, unknown>>

    return rows.map((row) => ({
      runId: row.run_id as string,
      parentSessionId: row.parent_session_id as string,
      parentAgentId: (row.parent_agent_id as string) || null,
      parentUserId: (row.parent_user_id as string) || undefined,
      childSessionKey: row.child_session_key as string,
      task: row.task as string,
      taskTitles: JSON.parse(row.task_titles as string),
      status: row.status as SubagentRunRecord["status"],
      startedAt: row.started_at as number,
      completedAt: (row.completed_at as number) || undefined,
      result: (row.result as string) || undefined,
      error: (row.error as string) || undefined,
    }))
  } catch {
    return []
  }
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
  _db = null
}
