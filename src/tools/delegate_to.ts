// src/tools/delegate_to.ts
/**
 * Tool: delegate_to — 委派任务给指定命名 Agent
 *
 * 与 delegate_tasks（匿名子 Agent 并行执行）不同，delegate_to 是：
 * - 指定目标 Agent（按 config 中定义的 name）
 * - 目标 Agent 使用自己的 system prompt、工具集、模型
 * - 异步执行，结果通过 Mailbox 回报给父 Agent
 *
 * 用法示例：
 *   delegate_to({ target: "translator", task: "翻译这段话", context: "..." })
 */

import { registry } from "./registry.js"
import { getMultiAgentRuntime } from "../multi-agent/runtime-context.js"
import { getTemplateByName, listTemplateNames, getAllTemplates } from "../agents/templates.js"
import { sendTask, markExecuting, reportResult } from "../multi-agent/mailbox.js"
import { emitLifecycle } from "../multi-agent/lifecycle-bus.js"
import { registerRun, completeRun, failRun } from "../multi-agent/subagent-registry.js"
import { randomUUID } from "crypto"
import type { AgentTemplate } from "../agents/templates.js"

registry.register({
  name: "delegate_to",
  description:
    "委派任务给指定的命名助手（Agent）。目标助手有自己的专业能力和工具集。" +
    "调用后立即返回（不阻塞），目标助手在后台执行，完成后结果自动推送。" +
    "可用的助手列表会在运行时动态提供。",
  schema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "目标助手的名称（如 translator、researcher）。",
      },
      task: {
        type: "string",
        description: "要委派的任务描述。目标助手看不到当前对话，所以要自包含。",
      },
      context: {
        type: "string",
        description: "可选。传递给目标助手的额外上下文信息。",
      },
    },
    required: ["target", "task"],
  },
  executionMode: "sequential",
  handler: async (params, ctx) => {
    const targetName = String(params["target"] ?? "")
    const task = String(params["task"] ?? "")
    const context = params["context"] ? String(params["context"]) : undefined

    if (!targetName || !task) {
      return { type: "error", error: "delegate_to: target 和 task 不能为空。" }
    }

    // Check runtime
    const rt = getMultiAgentRuntime()
    if (!rt) {
      return { type: "error", error: "delegate_to: 多 Agent 运行时未初始化。" }
    }

    // Resolve target template
    const template = getTemplateByName(targetName)
    if (!template) {
      const available = listTemplateNames()
      return {
        type: "error",
        error: `delegate_to: 未找到名为「${targetName}」的助手。可用助手：${available.join("、") || "（无）"}`,
      }
    }

    // Create mailbox message
    const parentAgentId = ctx.extra?.["targetAgentId"] as string | undefined
    const parentUserId = ctx.extra?.["userId"] as string | undefined
    const msg = sendTask({
      from: parentAgentId ?? ctx.sessionId,
      to: targetName,
      task,
      context,
    })

    // Register run in subagent registry
    const runId = `run_${randomUUID().slice(0, 12)}`
    registerRun({
      runId,
      parentSessionId: ctx.sessionId,
      parentAgentId: parentAgentId ?? null,
      parentUserId,
      childSessionKey: `named:${targetName}:${msg.id}`,
      task: `[${template.displayName}] ${task.slice(0, 60)}`,
      taskTitles: [template.displayName + ": " + task.slice(0, 40)],
      status: "running",
      startedAt: Date.now(),
    })

    // Emit lifecycle start
    emitLifecycle({
      runId,
      phase: "start",
      sessionKey: `named:${targetName}:${msg.id}`,
      parentSessionId: ctx.sessionId,
      parentAgentId,
      taskDescription: `${template.displayName}: ${task.slice(0, 60)}`,
    })

    // Fire-and-forget: execute in background with target's config
    markExecuting(msg.id)
    void executeNamedAgent(runId, msg.id, template, task, context, ctx.sessionId, rt).catch(
      (err) => {
        console.error(`[delegate_to] background error for ${targetName}:`, err)
        failRun(runId, err instanceof Error ? err.message : String(err))
        reportResult(msg.id, { success: false, output: String(err) })
      },
    )

    return {
      type: "text",
      text: [
        `✅ 已委派给「${template.displayName}」(${targetName})`,
        `任务: ${task.slice(0, 80)}`,
        `消息ID: ${msg.id}`,
        "",
        `目标助手正在后台执行，完成后结果会自动推送。你可以继续处理其他事务。`,
      ].join("\n"),
    }
  },
})

// ── Background execution ───────────────────────────────────────────────────────

async function executeNamedAgent(
  runId: string,
  messageId: string,
  template: AgentTemplate,
  task: string,
  context: string | undefined,
  parentSessionId: string,
  rt: { chatFn: any; toolRegistry: any },
): Promise<void> {
  const startTime = Date.now()

  // Build messages with target agent's system prompt
  const messages: any[] = []
  if (template.systemPrompt) {
    messages.push({ role: "system", content: template.systemPrompt })
  }
  const userContent = context
    ? `${task}\n\n---\n上下文信息：\n${context}`
    : task
  messages.push({ role: "user", content: userContent })

  try {
    // Use the chatFn with the target's model preference
    const result = await rt.chatFn(messages, {
      model: template.model,
    })

    const output = result.content || "(无输出)"
    const durationMs = Date.now() - startTime

    // Report success — completeRun emits lifecycle "end" event automatically,
    // which triggers ResultInjector to push to user + inject into session.
    completeRun(runId, output)
    // Also report via mailbox (for onTaskResult subscribers)
    reportResult(messageId, { success: true, output, durationMs })

    console.log(
      `[delegate_to] ${template.displayName} completed in ${durationMs}ms`,
    )
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    // failRun emits lifecycle "error" event automatically
    failRun(runId, errorMsg)
    reportResult(messageId, { success: false, output: errorMsg })
  }
}

// ── Dynamic description update ─────────────────────────────────────────────────

/**
 * Update delegate_to tool description and schema to include available agent names.
 * Call this AFTER loadAgentTemplates() so the LLM knows which agents exist.
 */
export function updateDelegateToDescription(): void {
  const templates = listTemplateNames()
  if (templates.length === 0) return

  const tool = registry.get("delegate_to")
  if (!tool) return

  const allTemplates = getAllTemplates()

  // Build rich description with agent capabilities
  const agentList = allTemplates
    .map((t) => `• ${t.name}（${t.displayName}）: ${t.capabilities || "通用助手"}`)
    .join("\n")

  tool.description =
    "委派任务给指定的命名助手（Agent）。目标助手有自己的专业能力和工具集。" +
    "调用后立即返回（不阻塞），目标助手在后台执行，完成后结果自动推送。\n\n" +
    "可用的助手：\n" +
    agentList

  // Also update the target property enum so LLM knows valid values
  if (tool.schema.properties && typeof tool.schema.properties === "object") {
    const targetProp = (tool.schema.properties as Record<string, any>)["target"]
    if (targetProp) {
      targetProp.enum = templates
      targetProp.description = `目标助手的名称。可选值：${templates.join("、")}`
    }
  }

  console.log(`[delegate_to] Updated description with ${templates.length} agent templates: ${templates.join(", ")}`)
}
