/**
 * Result Injector — 子任务结果注入/唤醒机制
 *
 * 监听 LifecycleBus 的 end/error 事件，将子任务结果推送给用户，
 * 并注入回父 Agent 的 session memory（使父 Agent 下次被唤醒时能看到结果）。
 * 
 * 注入方式：
 * 1. QQ Bot 渠道：通过注册的 pushFn 主动发消息给用户
 * 2. Context Injection：通过 contextInjector 写入父 session memory
 * 3. HTTP API 渠道：写入 session memory，下次 chat 时 agent 可见
 *
 * 参考 OpenClaw 的 subagent-announce-delivery.ts，但简化为：
 * - 我们不需要 steer 活跃 run（因为父 Agent 已经结束了本轮）
 * - 直接通过渠道推送 + session 注入即可
 */

import { onLifecycle, type LifecycleEvent } from "./lifecycle-bus.js"
import { getRun } from "./subagent-registry.js"

// ── 推送函数注册 ──────────────────────────────────────────────────────────────

/**
 * 推送函数签名：将消息推送给指定用户。
 * 由 QQBotChannel 在启动时注册。
 */
export type PushFn = (userId: string, content: string) => Promise<void>

let _pushFn: PushFn | null = null

/**
 * 注册推送函数（由渠道层调用）。
 */
export function registerPushFn(fn: PushFn): void {
  _pushFn = fn
  console.log("[ResultInjector] pushFn registered")
}

/**
 * 获取当前推送函数（用于测试）。
 */
export function getPushFn(): PushFn | null {
  return _pushFn
}

// ── Context Injector 注册 ─────────────────────────────────────────────────────

/**
 * Context Injector: writes result into parent session memory so the parent
 * agent sees it on next turn (Wake mechanism).
 */
export type ContextInjectorFn = (sessionId: string, content: string) => Promise<void>

let _contextInjector: ContextInjectorFn | null = null

/**
 * Register a function that injects messages into a session's memory.
 * Called by QQBotChannel at startup.
 */
export function registerContextInjector(fn: ContextInjectorFn): void {
  _contextInjector = fn
  console.log("[ResultInjector] contextInjector registered")
}

/**
 * Get current context injector (for testing).
 */
export function getContextInjector(): ContextInjectorFn | null {
  return _contextInjector
}

// ── 监听器初始化 ──────────────────────────────────────────────────────────────

let _initialized = false

/**
 * 初始化 ResultInjector。在服务启动时调用一次。
 * 注册 LifecycleBus 监听器，处理子任务完成事件。
 */
export function initResultInjector(): void {
  if (_initialized) return
  _initialized = true

  onLifecycle((evt) => {
    // 只处理终态事件
    if (evt.phase !== "end" && evt.phase !== "error" && evt.phase !== "aborted") return

    void handleCompletion(evt).catch((err) => {
      console.error("[ResultInjector] handleCompletion error:", err)
    })
  })

  console.log("[ResultInjector] initialized, listening for lifecycle events")
}

// ── 完成处理 ──────────────────────────────────────────────────────────────────

async function handleCompletion(evt: LifecycleEvent): Promise<void> {
  const record = getRun(evt.runId)
  if (!record) {
    console.warn(`[ResultInjector] no record for runId=${evt.runId}, skipping`)
    return
  }

  // 构造通知消息
  const message = formatCompletionMessage(evt, record)

  // 1. 推送给用户（实时通知）
  if (_pushFn && record.parentUserId) {
    try {
      await _pushFn(record.parentUserId, message)
      console.log(
        `[ResultInjector] pushed result to user=${record.parentUserId.slice(0, 8)}…, run=${evt.runId}`,
      )
    } catch (err) {
      console.error(
        `[ResultInjector] push failed for user=${record.parentUserId.slice(0, 8)}…:`,
        err,
      )
    }
  } else {
    console.log(
      `[ResultInjector] no pushFn or userId for run=${evt.runId}, result stored in registry only`,
    )
  }

  // 2. 注入父 session memory（使父 Agent 下次能看到结果）
  if (_contextInjector && record.parentSessionId) {
    try {
      await _contextInjector(record.parentSessionId, message)
      console.log(
        `[ResultInjector] injected result into session=${record.parentSessionId.slice(0, 8)}…, run=${evt.runId}`,
      )
    } catch (err) {
      console.error(
        `[ResultInjector] context injection failed for session=${record.parentSessionId.slice(0, 8)}…:`,
        err,
      )
    }
  }
}

// ── 消息格式化 ────────────────────────────────────────────────────────────────

function formatCompletionMessage(
  evt: LifecycleEvent,
  record: { taskTitles: string[]; startedAt: number },
): string {
  const durationSec = Math.round((Date.now() - record.startedAt) / 1000)
  const taskList = record.taskTitles.join("、")

  if (evt.phase === "end") {
    return [
      `📋 后台任务完成（耗时 ${durationSec}s）`,
      `任务：${taskList}`,
      "",
      evt.result || "(无详细输出)",
    ].join("\n")
  }

  if (evt.phase === "error") {
    return [
      `❌ 后台任务失败（耗时 ${durationSec}s）`,
      `任务：${taskList}`,
      `错误：${evt.error || "未知错误"}`,
    ].join("\n")
  }

  // aborted
  return [
    `⚠️ 后台任务已中止（耗时 ${durationSec}s）`,
    `任务：${taskList}`,
    `原因：${evt.error || "超时"}`,
  ].join("\n")
}

/** Test helper */
export function __resetResultInjector(): void {
  _pushFn = null
  _contextInjector = null
  _initialized = false
}
