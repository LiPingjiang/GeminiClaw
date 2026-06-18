// src/tools/delegate_tasks.ts
// Tool: delegate a batch of independent sub-tasks to isolated sub-agents that
// run asynchronously in the background (non-blocking, OpenClaw-style).
//
// Architecture change (v2):
// - OLD: await orchestrator.execute() → blocks parent agent for minutes
// - NEW: asyncExecute() → returns "accepted" in <10ms, results pushed via LifecycleBus
//
// The parent agent is immediately free to respond to new user messages.
// When sub-tasks complete, ResultInjector pushes results to the user via QQ/channel.

import { registry } from "./registry.js"
import { asyncExecute, MAX_CONCURRENT_RUNS_PER_PARENT } from "../multi-agent/async-executor.js"
import { getRunningForParent } from "../multi-agent/subagent-registry.js"
import type { TaskSpec } from "../multi-agent/task-delegator.js"
import type { TaskPriority, ExecutionStrategy, ContextMode } from "../multi-agent/types.js"

// Tools a leaf sub-agent must never use (prevents runaway recursion / fan-out).
const LEAF_DENIED_TOOLS = ["delegate_tasks", "create_agent", "switch_agent"]

const MAX_TASKS_PER_CALL = 6
const DEFAULT_MAX_CONCURRENT = 4
const DEFAULT_MAX_TURNS = 8

registry.register({
  name: "delegate_tasks",
  description:
    "把多个相互独立、可并行的子任务派给隔离的子 Agent 后台异步执行。" +
    "调用后立即返回（不阻塞），子任务完成后结果会自动推送给用户。" +
    "适合：1) 多个互不依赖、可同时推进的子任务（如同时调研多个主题）；" +
    "2) 耗时较长的任务（如浏览器爬取、大规模文件处理）；" +
    "3) 需要独立干净视角的子调查。" +
    "不要用于：单次工具调用即可完成的小事、需要与用户来回交互的任务。" +
    "子 Agent 默认隔离（不读父对话、不能再次委派），完成后结果自动推送。" +
    "\n\n❗ 系统能力边界（你 MUST NOT 对用户承诺超出这些限制的能力）：" +
    `同一时间最多 ${MAX_CONCURRENT_RUNS_PER_PARENT} 个后台任务在运行（超出会被拒绝）；` +
    `每次调用最多 ${MAX_TASKS_PER_CALL} 个子任务；` +
    "如果用户要求的并发数超过系统上限，你 MUST 如实告知用户实际能力，而不是假装可以做到。" +
    "正确做法：告诉用户'系统最多同时运行 3 个后台任务，我会分批执行'。" +
    "\n\n💡 派发后如需查看子任务进度，使用 check_subagent_tasks 工具（不要凭记忆猜测状态）。",
  schema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        description: "要并行委派的子任务列表（1~6 个）。每个子任务由一个独立子 Agent 执行。",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "子任务简短标题" },
            description: {
              type: "string",
              description: "子任务的完整目标与必要上下文。子 Agent 看不到父对话，所以这里要自包含。",
            },
            allowed_tools: {
              type: "array",
              items: { type: "string" },
              description: "可选。限定该子 Agent 可用的工具白名单（留空=继承标准工具集，但仍禁止委派类工具）。",
            },
            depends_on: {
              type: "array",
              items: { type: "string" },
              description: "可选。该子任务依赖的其它子任务的 title（仅在 strategy=dependency_graph 时生效）。",
            },
            priority: {
              type: "string",
              enum: ["low", "normal", "high", "critical"],
              description: "可选，默认 normal。",
            },
            max_turns: {
              type: "number",
              description: "可选，该子 Agent 的最大轮数，默认 8。",
            },
            role: {
              type: "string",
              enum: ["leaf", "orchestrator"],
              description:
                "可选，默认 leaf（不可再委派）。仅当确需再嵌套一层委派时设为 orchestrator。",
            },
            context: {
              type: "string",
              description: "可选。补充上下文或约束条件，会追加到 description 后面一起传给子 Agent。",
            },
            context_mode: {
              type: "string",
              enum: ["isolated", "fork", "lightweight"],
              description:
                "可选，默认 isolated。控制子 Agent 继承多少父上下文：" +
                "isolated=只有技能+任务描述（默认，适合独立任务）；" +
                "fork=继承父对话压缩摘要+per-agent记忆（适合需要理解对话背景的任务）；" +
                "lightweight=最小化启动，不注入技能（适合简单工具调用任务，省token）。",
            },
          },
          required: ["title", "description"],
        },
      },
      strategy: {
        type: "string",
        enum: ["parallel", "sequential", "dependency_graph"],
        description: "执行策略，默认 parallel（全部并行）。有依赖关系时用 dependency_graph。",
      },
      max_concurrent: {
        type: "number",
        description: "可选，最大并发数，默认 4。",
      },
      timeout_seconds: {
        type: "number",
        description:
          "可选，子任务整体超时（秒）。默认 300（5 分钟）。" +
          "对于耗时较长的任务（如浏览器爬取、大规模文件处理），建议设为 600~1800。" +
          "最小 60 秒，最大 3600 秒（1 小时）。",
      },
    },
    required: ["tasks"],
  },
  // Non-blocking now, but keep sequential to avoid racing with other tools in same turn
  executionMode: "sequential",
  handler: async (params, ctx) => {
    const rawTasks = Array.isArray(params["tasks"]) ? params["tasks"] : []
    if (rawTasks.length === 0) {
      return { type: "error", error: "delegate_tasks: tasks 不能为空。" }
    }
    if (rawTasks.length > MAX_TASKS_PER_CALL) {
      return {
        type: "error",
        error: `delegate_tasks: 单次最多委派 ${MAX_TASKS_PER_CALL} 个子任务，收到 ${rawTasks.length} 个。`,
      }
    }

    const strategy =
      (params["strategy"] as ExecutionStrategy) ?? "parallel"
    const maxConcurrent =
      typeof params["max_concurrent"] === "number" && params["max_concurrent"] > 0
        ? Math.min(params["max_concurrent"] as number, 8)
        : DEFAULT_MAX_CONCURRENT

    // Timeout: clamp to [60, 3600] seconds, default 300s (5 min)
    const MIN_TIMEOUT_S = 60
    const MAX_TIMEOUT_S = 3600
    const DEFAULT_TIMEOUT_S = 300
    const rawTimeout = typeof params["timeout_seconds"] === "number"
      ? params["timeout_seconds"] as number
      : DEFAULT_TIMEOUT_S
    const timeoutMs = Math.max(MIN_TIMEOUT_S, Math.min(MAX_TIMEOUT_S, rawTimeout)) * 1000

    // Build task specs
    const taskSpecs: TaskSpec[] = rawTasks.map((t: Record<string, unknown>) => {
      const role = (t["role"] as string) === "orchestrator" ? "orchestrator" : "leaf"
      const requestedTools = Array.isArray(t["allowed_tools"])
        ? (t["allowed_tools"] as string[])
        : []
      const allowedTools =
        role === "leaf"
          ? requestedTools.filter((name) => !LEAF_DENIED_TOOLS.includes(name))
          : requestedTools

      // Merge context into description if provided
      const baseDesc = String(t["description"] ?? "")
      const extraContext = t["context"] ? String(t["context"]) : ""
      const fullDescription = extraContext
        ? `${baseDesc}\n\n**补充约束**: ${extraContext}`
        : baseDesc

      return {
        title: String(t["title"] ?? "subtask"),
        description: fullDescription,
        priority: (t["priority"] as TaskPriority) ?? "normal",
        allowedTools,
        maxTurns:
          typeof t["max_turns"] === "number"
            ? (t["max_turns"] as number)
            : DEFAULT_MAX_TURNS,
        dependsOn: [],
        contextMode: (t["context_mode"] as ContextMode) ?? "isolated",
      }
    })

    // Extract parent context from tool context
    // IMPORTANT: If current session is a temporary one (mem-* for memory manager),
    // resolve the user's real agent session so results are injected correctly.
    let parentSessionId = ctx.sessionId ?? "unknown"
    const parentAgentId = ctx.extra?.["targetAgentId"] as string | undefined
    const parentUserId = ctx.extra?.["userId"] as string | undefined
    const db = ctx.extra?.["db"] as { prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } } | undefined

    if (parentSessionId.startsWith("mem-") || parentSessionId.startsWith("subagent:")) {
      // We're inside a temporary session (memory manager or sub-agent).
      // Look up the user's real agent session from the database.
      if (db && parentUserId) {
        try {
          const row = db.prepare(
            "SELECT session_id FROM user_sessions WHERE openid = ?"
          ).get(parentUserId) as { session_id: string } | undefined
          if (row?.session_id) {
            console.log(
              `[delegate_tasks] Resolved real session: ${parentSessionId.slice(0, 12)}… → ${row.session_id.slice(0, 12)}…`
            )
            parentSessionId = row.session_id
          }
        } catch (err) {
          console.warn(`[delegate_tasks] Failed to resolve real session for user=${parentUserId?.slice(0, 8)}…:`, err)
        }
      }
    }

    // Extract parent context for fork mode (compressed recent conversation)
    let parentContext: string | undefined
    const hasForkTask = taskSpecs.some((t) => t.contextMode === "fork")
    if (hasForkTask && db && parentSessionId) {
      try {
        const rows = db.prepare(
          `SELECT role, substr(content, 1, 500) AS content
           FROM chat_messages
           WHERE session_id = ?
           ORDER BY created_at DESC LIMIT 20`,
        ).all(parentSessionId) as Array<{ role: string; content: string }>
        if (rows.length > 0) {
          // Build compressed summary (most recent first, then reverse for chronological order)
          const messages = rows.reverse().map((r) => `[${r.role}]: ${r.content}`).join("\n")
          parentContext = `以下是父对话最近 ${rows.length} 条消息的摘要：\n\n${messages}`
        }
      } catch {
        // Non-fatal: proceed without parent context
      }
    }

    // Fire-and-forget: launch async execution
    const result = asyncExecute(taskSpecs, {
      parentSessionId,
      parentAgentId: parentAgentId ?? null,
      parentUserId,
      strategy,
      maxConcurrent,
      timeoutMs,
      parentContext,
      logger: ctx.logger,
    })

    if (!result.accepted) {
      return {
        type: "error",
        error: `delegate_tasks: 任务被拒绝 — ${result.rejectReason}`,
      }
    }

    // Show current running tasks for context — inject system capacity info
    const running = getRunningForParent(parentSessionId)
    const slotsUsed = running.length
    const slotsRemaining = MAX_CONCURRENT_RUNS_PER_PARENT - slotsUsed

    // Return immediately — parent agent is NOT blocked
    const taskList = taskSpecs.map((t, i) => `  ${i + 1}. ${t.title}`).join("\n")
    return {
      type: "text",
      text: [
        `✅ 已接受 ${taskSpecs.length} 个子任务，后台异步执行中。`,
        `任务ID: ${result.runId}`,
        `策略: ${strategy}`,
        `超时: ${timeoutMs / 1000}s`,
        `任务列表:`,
        taskList,
        "",
        `📊 系统状态: ${slotsUsed}/${MAX_CONCURRENT_RUNS_PER_PARENT} 后台槽位已占用，剩余 ${slotsRemaining} 个可用。`,
        slotsRemaining === 0
          ? `⚠️ 后台槽位已满，下次调用将被拒绝。需等待当前任务完成后才能启动新任务。`
          : `还可以再启动 ${slotsRemaining} 个后台任务。`,
        "",
        `子任务完成后结果会自动推送给用户，你无需等待。`,
        `你现在可以继续回答用户的其他问题。`,
      ].join("\n"),
    }
  },
})
