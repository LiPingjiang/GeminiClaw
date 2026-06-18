// src/tools/check_subagent_tasks.ts
// Tool: query the status of delegated sub-tasks (running, completed, failed).
//
// This bridges the gap where the parent Agent has no way to check on
// tasks it previously dispatched via delegate_tasks. Without this tool,
// the Agent can only passively wait for ResultInjector to push results.

import { registry } from "./registry.js"
import {
  getRunningForParent,
  getAllForParent,
  type SubagentRunRecord,
} from "../multi-agent/subagent-registry.js"

registry.register({
  name: "check_subagent_tasks",
  description:
    "查询你之前通过 delegate_tasks 派出的后台子任务的当前状态。" +
    "可以查看哪些任务正在运行、已完成、已失败，以及已完成任务的结果摘要。" +
    "当用户询问'进展如何''做完了吗''什么状态'时，MUST 先调用此工具获取真实状态再回复。" +
    "不要凭记忆回答子任务进度——你的记忆可能过时，此工具返回的是实时系统状态。",
  schema: {
    type: "object",
    properties: {
      filter: {
        type: "string",
        enum: ["all", "running", "completed", "failed"],
        description:
          "过滤条件：all=全部（默认），running=仅运行中，completed=仅已完成，failed=仅失败/中止。",
      },
      run_id: {
        type: "string",
        description: "可选。指定查询某个特定 runId 的详细信息。",
      },
    },
    required: [],
  },
  executionMode: "parallel",
  handler: async (_params, ctx) => {
    const filter = ((_params["filter"] as string) ?? "all") as
      | "all"
      | "running"
      | "completed"
      | "failed"
    const runId = _params["run_id"] as string | undefined

    const parentSessionId = ctx.sessionId ?? "unknown"

    // If a specific runId is requested, try to find it
    if (runId) {
      const all = getAllForParent(parentSessionId)
      const record = all.find((r) => r.runId === runId)
      if (!record) {
        return {
          type: "text",
          text: `未找到 runId=${runId} 的任务记录。可能已过期或不属于当前会话。`,
        }
      }
      return { type: "text", text: formatRecord(record, true) }
    }

    // Get all records for this parent session
    let records: SubagentRunRecord[]
    if (filter === "running") {
      records = getRunningForParent(parentSessionId)
    } else {
      records = getAllForParent(parentSessionId)
      if (filter === "completed") {
        records = records.filter((r) => r.status === "completed")
      } else if (filter === "failed") {
        records = records.filter(
          (r) => r.status === "failed" || r.status === "aborted",
        )
      }
    }

    if (records.length === 0) {
      const hint =
        filter === "running"
          ? "当前没有正在运行的后台任务。"
          : "没有找到任何后台任务记录。可能所有任务已完成并被清理，或尚未派发过任务。"
      return { type: "text", text: hint }
    }

    // Build summary
    const lines: string[] = []
    const running = records.filter((r) => r.status === "running")
    const completed = records.filter((r) => r.status === "completed")
    const failed = records.filter(
      (r) => r.status === "failed" || r.status === "aborted",
    )

    lines.push(`📊 后台任务状态总览:`)
    lines.push(
      `  运行中: ${running.length} | 已完成: ${completed.length} | 失败/中止: ${failed.length}`,
    )
    lines.push("")

    // Show running tasks
    if (running.length > 0 && (filter === "all" || filter === "running")) {
      lines.push(`🔄 运行中 (${running.length}):`)
      for (const r of running) {
        lines.push(formatRecord(r, false))
      }
      lines.push("")
    }

    // Show completed tasks
    if (completed.length > 0 && (filter === "all" || filter === "completed")) {
      lines.push(`✅ 已完成 (${completed.length}):`)
      for (const r of completed) {
        lines.push(formatRecord(r, filter === "completed"))
      }
      lines.push("")
    }

    // Show failed tasks
    if (failed.length > 0 && (filter === "all" || filter === "failed")) {
      lines.push(`❌ 失败/中止 (${failed.length}):`)
      for (const r of failed) {
        lines.push(formatRecord(r, filter === "failed"))
      }
      lines.push("")
    }

    return { type: "text", text: lines.join("\n") }
  },
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatRecord(r: SubagentRunRecord, detailed: boolean): string {
  const elapsed = r.completedAt
    ? `${Math.round((r.completedAt - r.startedAt) / 1000)}s`
    : `${Math.round((Date.now() - r.startedAt) / 1000)}s (进行中)`

  const icon =
    r.status === "running"
      ? "🔄"
      : r.status === "completed"
        ? "✅"
        : r.status === "failed"
          ? "❌"
          : "⛔"

  const header = `  ${icon} [${r.runId}] ${r.taskTitles.join(", ")} — ${r.status} (${elapsed})`

  if (!detailed) return header

  const lines = [header]
  if (r.result) {
    // Truncate long results
    const result =
      r.result.length > 1500 ? r.result.slice(0, 1500) + "…(截断)" : r.result
    lines.push(`     结果: ${result}`)
  }
  if (r.error) {
    lines.push(`     错误: ${r.error}`)
  }
  return lines.join("\n")
}
