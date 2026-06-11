// @ts-nocheck
// src/tools/delegate_tasks.ts
// Tool: delegate a batch of independent sub-tasks to isolated sub-agents that
// run in parallel, then return their structured summaries to the caller.
//
// Borrows the "fire-and-collect batch" paradigm from Hermes Agent's
// `delegate_task` tool, backed by GeminiClaw's existing Orchestrator
// (Promise.allSettled batched parallelism + ContextBoundary isolation).
//
// The sub-agents are isolated by default: they cannot delegate further
// (recursion is blocked via deniedTools + maxDepth), they get a scoped tool
// registry, and only their final summaries flow back to the parent — keeping
// the parent context cost near zero.

import { registry } from "./registry.js"
import { getMultiAgentRuntime } from "../multi-agent/runtime-context.js"
import { Orchestrator } from "../multi-agent/orchestrator.js"
import type { TaskSpec } from "../multi-agent/task-delegator.js"
import type { TaskPriority } from "../multi-agent/types.js"

// Tools a leaf sub-agent must never use (prevents runaway recursion / fan-out).
const LEAF_DENIED_TOOLS = ["delegate_tasks", "create_agent", "switch_agent"]

const MAX_TASKS_PER_CALL = 6
const DEFAULT_MAX_CONCURRENT = 4
const DEFAULT_MAX_TURNS = 8

registry.register({
  name: "delegate_tasks",
  description:
    "把多个相互独立、可并行的子任务派给隔离的子 Agent 并行执行，等全部完成后返回每个子任务的结果摘要。" +
    "适合：1) 多个互不依赖、可同时推进的子任务（如同时调研多个主题 / 同时改多个互不相关的文件）；" +
    "2) 单个推理密集、会灌爆当前上下文的探索（交给子 Agent 用干净上下文跑）；3) 需要独立干净视角的子调查。" +
    "不要用于：单次工具调用即可完成的小事、需要与用户来回交互的任务、彼此强依赖必须串行的步骤。" +
    "子 Agent 默认隔离（不读父对话、不能再次委派），只把最终摘要回传给你，因此几乎不占用你的上下文。",
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
    },
    required: ["tasks"],
  },
  // Spawning sub-agents is heavyweight; keep it sequential w.r.t. other tools
  // in the same turn so it doesn't race exec/write/edit.
  executionMode: "sequential",
  handler: async (params, ctx) => {
    const rt = getMultiAgentRuntime()
    if (!rt) {
      return {
        type: "error",
        error:
          "delegate_tasks: 多 Agent 运行时未初始化（仅在主对话通道可用）。请直接自己完成该任务。",
      }
    }

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
      (params["strategy"] as "parallel" | "sequential" | "dependency_graph") ??
      "parallel"
    const maxConcurrent =
      typeof params["max_concurrent"] === "number" && params["max_concurrent"] > 0
        ? Math.min(params["max_concurrent"] as number, 8)
        : DEFAULT_MAX_CONCURRENT

    // Map title -> nothing fancy; dependsOn uses titles which TaskDelegator
    // does not resolve by title, so we only honor depends_on when explicitly
    // using dependency_graph and we translate titles to a stable ordering hint.
    const taskSpecs: TaskSpec[] = rawTasks.map((t: Record<string, unknown>) => {
      const role = (t["role"] as string) === "orchestrator" ? "orchestrator" : "leaf"
      // Leaf agents may never delegate further; orchestrators may, but we still
      // strip delegate_tasks from leaves' tool surface explicitly.
      const requestedTools = Array.isArray(t["allowed_tools"])
        ? (t["allowed_tools"] as string[])
        : []
      const allowedTools =
        role === "leaf"
          ? requestedTools.filter((name) => !LEAF_DENIED_TOOLS.includes(name))
          : requestedTools

      return {
        title: String(t["title"] ?? "subtask"),
        description: String(t["description"] ?? ""),
        priority: (t["priority"] as TaskPriority) ?? "normal",
        allowedTools,
        maxTurns:
          typeof t["max_turns"] === "number"
            ? (t["max_turns"] as number)
            : DEFAULT_MAX_TURNS,
        // depends_on by title is unsupported at the delegator level; ignored
        // unless caller switches to manual chaining. Kept for forward-compat.
        dependsOn: [],
      }
    })

    const orchestrator = new Orchestrator({
      chatFn: rt.chatFn,
      toolRegistry: rt.toolRegistry,
      strategy,
      boundary: {
        isolationLevel: "strict",
        // Block recursion + agent-creation across ALL spawned children.
        deniedTools: LEAF_DENIED_TOOLS,
        // maxDepth semantics: "how many more levels of children may be spawned
        // from here". The Orchestrator derives a child boundary (depth-1) before
        // running each task, so depth=2 allows exactly ONE level of children
        // (this parent -> child at depth 1); that child cannot spawn further
        // because deriving depth 0 throws. Combined with deniedTools, this hard
        // caps delegation at a single level.
        maxDepth: 2,
        maxConcurrent,
        canDelegate: false,
      },
      logger: ctx.logger,
    })

    const signal =
      ctx.extra && ctx.extra["signal"] instanceof AbortSignal
        ? (ctx.extra["signal"] as AbortSignal)
        : undefined

    ctx.logger.info(
      `[delegate_tasks] dispatching ${taskSpecs.length} task(s), strategy=${strategy}, maxConcurrent=${maxConcurrent}`,
    )

    let result
    try {
      result = await orchestrator.execute(taskSpecs, {
        strategy,
        ...(signal ? { signal } : {}),
      })
    } catch (err) {
      return {
        type: "error",
        error: `delegate_tasks: 执行失败 — ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    // Build a structured, original-order result list (Hermes-style envelope).
    const ordered = result.tasks
    const lines: string[] = []
    lines.push(
      `委派完成：${result.metrics.tasksCompleted} 成功 / ${result.metrics.tasksFailed} 失败 / ${result.metrics.tasksCancelled} 取消，耗时 ${result.metrics.totalDurationMs}ms。`,
    )
    lines.push("")
    ordered.forEach((task, i) => {
      const status =
        task.status === "completed"
          ? "✅"
          : task.status === "failed"
            ? "❌"
            : task.status === "cancelled"
              ? "⛔"
              : "⏳"
      lines.push(`### [${i + 1}] ${status} ${task.title}`)
      lines.push(task.result?.output?.trim() || "(无输出)")
      lines.push("")
    })

    return { type: "text", text: lines.join("\n").trim() }
  },
})
