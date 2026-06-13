/**
 * Result Injector — 子任务结果注入/唤醒机制
 *
 * 监听 LifecycleBus 的 end/error 事件，将子任务结果推送给用户。
 * 
 * 注入方式：
 * 1. QQ Bot 渠道：通过注册的 pushFn 主动发消息给用户
 * 2. HTTP API 渠道：写入 session memory，下次 chat 时 agent 可见
 *
 * 参考 OpenClaw 的 subagent-announce-delivery.ts，但简化为：
 * - 我们不需要 steer 活跃 run（因为父 Agent 已经结束了本轮）
 * - 直接通过渠道推送即可
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

  // 推送给用户
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
  _initialized = false
}
