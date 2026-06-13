/**
 * Lifecycle Bus — 进程内单例事件总线（参考 OpenClaw agent-events.ts）
 *
 * 用于子 Agent 生命周期事件的发布/订阅。当子任务完成或失败时，
 * 通过此总线通知 ResultInjector 将结果注入回父会话。
 *
 * 设计要点：
 * - 纯进程内，零外部依赖
 * - 同步通知所有监听器（fire-and-forget 语义）
 * - 每个事件带 runId + sessionKey 用于路由
 */

// ── 类型 ──────────────────────────────────────────────────────────────────────

export type LifecyclePhase = "start" | "end" | "error" | "aborted"

export interface LifecycleEvent {
  /** 子任务运行 ID */
  runId: string
  /** 生命周期阶段 */
  phase: LifecyclePhase
  /** 子任务的 session key（用于隔离） */
  sessionKey: string
  /** 父 session ID（用于结果路由） */
  parentSessionId: string
  /** 父 agent ID（可选，用于 QQ 渠道推送） */
  parentAgentId?: string | null
  /** 任务描述（用于通知消息） */
  taskDescription?: string
  /** 完成时的结果摘要 */
  result?: string
  /** 错误信息 */
  error?: string
  /** 事件时间戳 */
  ts: number
}

// ── 单例实现 ──────────────────────────────────────────────────────────────────

type LifecycleListener = (evt: LifecycleEvent) => void

const listeners = new Set<LifecycleListener>()

/**
 * 发布一个生命周期事件。同步通知所有监听器。
 */
export function emitLifecycle(event: Omit<LifecycleEvent, "ts">): void {
  const enriched: LifecycleEvent = { ...event, ts: Date.now() }
  for (const fn of listeners) {
    try {
      fn(enriched)
    } catch (err) {
      console.error("[LifecycleBus] listener threw:", err)
    }
  }
}

/**
 * 订阅生命周期事件。返回取消订阅函数。
 */
export function onLifecycle(fn: LifecycleListener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * 当前监听器数量（用于调试/测试）
 */
export function listenerCount(): number {
  return listeners.size
}

/** Test helper: clear all listeners */
export function __resetLifecycleBus(): void {
  listeners.clear()
}
