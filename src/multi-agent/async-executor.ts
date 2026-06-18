/**
 * Async Executor — Fire-and-forget 子任务执行器
 *
 * 接收 TaskSpec 列表，在后台异步执行（不阻塞调用方），
 * 完成后通过 SubagentRegistry 记录结果并触发 LifecycleBus 事件。
 *
 * 这是 OpenClaw 式非阻塞委派的核心：调用方只等"接受确认"（~10ms），
 * 真正的执行在独立的 Promise 链中进行。
 */

import { randomUUID } from "crypto"
import { Orchestrator } from "./orchestrator.js"
import { registerRun, completeRun, failRun } from "./subagent-registry.js"
import { emitLifecycle } from "./lifecycle-bus.js"
import { getMultiAgentRuntime } from "./runtime-context.js"
import { loadSystemPrompt } from "../memory/strategy.js"
import { resolveContext } from "./context-resolver.js"
import { WorkingMemoryBuilder } from "../memory/working-memory.js"
import { MemoryPaths } from "../memory/paths.js"
import type { TaskSpec } from "./task-delegator.js"
import type { ExecutionStrategy, ContextMode } from "./types.js"

// ── 配置 ──────────────────────────────────────────────────────────────────────

/** 同一父 session 最大并行 run 数 */
export const MAX_CONCURRENT_RUNS_PER_PARENT = 3

/** 子任务默认超时（5 分钟） */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

// Tools a leaf sub-agent must never use
const LEAF_DENIED_TOOLS = ["delegate_tasks", "create_agent", "switch_agent"]

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface AsyncExecuteOptions {
  /** 父 session ID（用于结果路由） */
  parentSessionId: string
  /** 父 agent ID（用于 QQ 渠道推送） */
  parentAgentId?: string | null
  /** 父用户 ID（用于 QQ 渠道推送） */
  parentUserId?: string
  /** 执行策略 */
  strategy?: ExecutionStrategy
  /** 最大并发数 */
  maxConcurrent?: number
  /** 超时 ms */
  timeoutMs?: number
  /** 父对话上下文摘要（fork 模式使用） */
  parentContext?: string
  /** Logger */
  logger?: {
    info(msg: string, ...args: unknown[]): void
    warn(msg: string, ...args: unknown[]): void
    error(msg: string, ...args: unknown[]): void
  }
}

export interface AsyncExecuteResult {
  /** 是否成功接受（可能因并发上限被拒绝） */
  accepted: boolean
  /** 分配的 runId（accepted=true 时有值） */
  runId?: string
  /** 拒绝原因 */
  rejectReason?: string
}

// ── 活跃 run 计数 ─────────────────────────────────────────────────────────────

import { getRunningForParent } from "./subagent-registry.js"

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * 异步启动子任务执行。立即返回 accepted/rejected，不等待完成。
 *
 * 这是 delegate_tasks 的非阻塞替代：
 * - 旧模式：await orchestrator.execute() → 阻塞数分钟
 * - 新模式：asyncExecute() → ≤10ms 返回 accepted，后台执行
 */
export function asyncExecute(
  taskSpecs: TaskSpec[],
  options: AsyncExecuteOptions,
): AsyncExecuteResult {
  const rt = getMultiAgentRuntime()
  if (!rt) {
    return { accepted: false, rejectReason: "多 Agent 运行时未初始化" }
  }

  // 并发上限检查
  const currentRunning = getRunningForParent(options.parentSessionId)
  if (currentRunning.length >= MAX_CONCURRENT_RUNS_PER_PARENT) {
    return {
      accepted: false,
      rejectReason: `已有 ${currentRunning.length} 个子任务在运行，达到上限 ${MAX_CONCURRENT_RUNS_PER_PARENT}`,
    }
  }

  const runId = `run_${randomUUID().slice(0, 12)}`
  const childSessionKey = `subagent:${runId}`
  const taskTitles = taskSpecs.map((t) => t.title)

  // 注册到 registry
  registerRun({
    runId,
    parentSessionId: options.parentSessionId,
    parentAgentId: options.parentAgentId ?? null,
    parentUserId: options.parentUserId,
    childSessionKey,
    task: taskSpecs.map((t) => `${t.title}: ${t.description.slice(0, 60)}`).join("; "),
    taskTitles,
    status: "running",
    startedAt: Date.now(),
  })

  // 发布 start 事件
  emitLifecycle({
    runId,
    phase: "start",
    sessionKey: childSessionKey,
    parentSessionId: options.parentSessionId,
    parentAgentId: options.parentAgentId,
    taskDescription: taskTitles.join(", "),
  })

  // Fire-and-forget：启动执行但不 await
  void executeInBackground(runId, taskSpecs, options, rt).catch((err) => {
    console.error(`[AsyncExecutor] unexpected top-level error for run=${runId}:`, err)
    failRun(runId, err instanceof Error ? err.message : String(err))
  })

  return { accepted: true, runId }
}

// ── 后台执行 ──────────────────────────────────────────────────────────────────

async function executeInBackground(
  runId: string,
  taskSpecs: TaskSpec[],
  options: AsyncExecuteOptions,
  rt: { chatFn: any; toolRegistry: any },
): Promise<void> {
  const strategy = options.strategy ?? "parallel"
  const maxConcurrent = options.maxConcurrent ?? 4
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const log = options.logger ?? console

  log.info(
    `[AsyncExecutor] run=${runId} starting: ${taskSpecs.length} task(s), strategy=${strategy}`,
  )

  // 超时控制
  const abortController = new AbortController()
  const timeoutHandle = setTimeout(() => {
    abortController.abort()
  }, timeoutMs)

  try {
    // Load the full system prompt (including skills) for context resolution
    const basePrompt = loadSystemPrompt()

    // Resolve context mode for the task batch.
    // Use the first task's contextMode as the batch mode (all tasks in a batch share mode).
    const requestedMode: ContextMode = taskSpecs[0]?.contextMode ?? "isolated"

    // Load per-agent memory if fork mode and parentAgentId is available
    let agentMemory: string | undefined
    if (requestedMode === "fork" && options.parentAgentId) {
      try {
        const paths = new MemoryPaths()
        const builder = new WorkingMemoryBuilder(paths)
        const today = new Date().toISOString().slice(0, 10)
        const wm = builder.build(options.parentAgentId, today)
        const memParts = [wm.agentFixed, wm.agentNonFixed].filter(Boolean)
        if (memParts.length > 0) {
          agentMemory = memParts.join("\n\n")
        }
      } catch {
        // Non-fatal: proceed without agent memory
      }
    }

    // Resolve effective context with token budget protection
    const contextResult = resolveContext({
      requestedMode,
      basePrompt,
      parentContext: options.parentContext,
      agentMemory,
      taskDescription: taskSpecs.map(t => `${t.title}: ${t.description}`).join("\n"),
    })

    if (contextResult.refused) {
      failRun(runId, contextResult.degradationReason ?? "Token budget exceeded")
      log.error(
        `[AsyncExecutor] run=${runId} refused: ${contextResult.degradationReason}`,
      )
      return
    }

    if (contextResult.degraded) {
      log.warn(
        `[AsyncExecutor] run=${runId} context degraded: ${requestedMode} → ${contextResult.effectiveMode} (${contextResult.estimatedTokens} tokens). Reason: ${contextResult.degradationReason}`,
      )
    }

    log.info(
      `[AsyncExecutor] run=${runId} context: mode=${contextResult.effectiveMode}, tokens≈${contextResult.estimatedTokens}`,
    )

    const orchestrator = new Orchestrator({
      chatFn: rt.chatFn,
      toolRegistry: rt.toolRegistry,
      strategy,
      systemPrompt: contextResult.systemPrompt ?? undefined,
      boundary: {
        isolationLevel: "strict",
        deniedTools: LEAF_DENIED_TOOLS,
        maxDepth: 2,
        maxConcurrent,
        canDelegate: false,
      },
      timeoutMs,
      logger: log as any,
    })

    const result = await orchestrator.execute(taskSpecs, {
      strategy,
      parentContext: contextResult.parentContext ?? undefined,
      signal: abortController.signal,
    })

    // 构建结果摘要
    const lines: string[] = []
    lines.push(
      `✅ 委派完成：${result.metrics.tasksCompleted} 成功 / ${result.metrics.tasksFailed} 失败，耗时 ${Math.round(result.metrics.totalDurationMs / 1000)}s`,
    )
    lines.push("")
    result.tasks.forEach((task, i) => {
      const icon =
        task.status === "completed" ? "✅" :
        task.status === "failed" ? "❌" :
        task.status === "cancelled" ? "⛔" : "⏳"
      lines.push(`[${i + 1}] ${icon} ${task.title}`)
      const output = task.result?.output?.trim()
      if (output) {
        // 截断过长的输出
        lines.push(output.length > 2000 ? output.slice(0, 2000) + "…" : output)
      } else {
        lines.push("(无输出)")
      }
      lines.push("")
    })

    const summary = lines.join("\n").trim()
    completeRun(runId, summary)

    log.info(`[AsyncExecutor] run=${runId} completed successfully`)
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    if (abortController.signal.aborted) {
      failRun(runId, `超时中止 (${timeoutMs / 1000}s)`)
    } else {
      failRun(runId, errorMsg)
    }
    log.error(`[AsyncExecutor] run=${runId} failed: ${errorMsg}`)
  } finally {
    clearTimeout(timeoutHandle)
  }
}
