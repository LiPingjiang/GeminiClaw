// src/agent/compact.ts
// Conversation compaction — summarises old history to reclaim context budget.
//
// Strategy (mirrors Claude Code's approach):
//   1. Keep the system prompt and the most recent N messages verbatim.
//   2. Send everything older to a cheap summarisation call.
//   3. Replace the compressed history with a single user+assistant summary pair.
//   4. The caller can continue the conversation with the compacted messages.

import type { InternalMessage, ChatFn } from "./loop.js"

/** Messages at the tail of the conversation always preserved verbatim. */
const KEEP_RECENT = 20

/** Max chars taken from each message when building the history to summarise. */
const MAX_MSG_CHARS = 3_000

const COMPACT_SYSTEM =
  `你是一个对话历史压缩助手。将收到一段 AI 助手与用户的对话历史，请把它压缩成一份精简的摘要。

摘要必须保留：
• 用户的核心目标和主要问题
• 已执行的关键操作及其结果（含文件路径、命令、策略名称等具体信息）
• 当前进度与未完成的待办事项
• 重要的错误或异常情况
• 用户明确表达的偏好或约束

格式：中文，结构清晰，使用标题和要点组织，去除无关闲聊。`

/**
 * Compact a conversation by summarising the older portion.
 * Returns the new (shorter) messages array and the generated summary text.
 */
export async function compactConversation(
  messages: InternalMessage[],
  chatFn: ChatFn,
  model?: string,
): Promise<{ messages: InternalMessage[]; summary: string; savedMessages: number }> {
  // Partition: system messages always stay; split non-system into old + recent
  const systemMsgs = messages.filter(m => m.role === "system")
  const nonSystem  = messages.filter(m => m.role !== "system")

  const splitAt  = Math.max(0, nonSystem.length - KEEP_RECENT)
  const toCompress = nonSystem.slice(0, splitAt)
  const toKeep     = nonSystem.slice(splitAt)

  if (toCompress.length === 0) {
    return { messages, summary: "", savedMessages: 0 }
  }

  // Build the plain-text blob we'll summarise
  const historyText = toCompress.map(m => {
    const label =
      m.role === "assistant" ? "AI助手" :
      m.role === "user"      ? "用户"   : "工具结果"
    const content =
      typeof m.content === "string"
        ? m.content
        : JSON.stringify(m.content)
    return `【${label}】\n${content.slice(0, MAX_MSG_CHARS)}${content.length > MAX_MSG_CHARS ? "\n…(截断)" : ""}`
  }).join("\n\n---\n\n")

  let summary: string
  try {
    const resp = await chatFn(
      [
        { role: "system", content: COMPACT_SYSTEM },
        { role: "user",   content: `请压缩以下对话历史（共 ${toCompress.length} 条消息）：\n\n${historyText}` },
      ],
      { model },
    )
    summary = resp.content.trim()
  } catch (err) {
    // If summarisation fails, fall back to a minimal stub so the caller can continue
    summary = `[对话历史摘要失败，已跳过 ${toCompress.length} 条旧消息]`
  }

  const compacted: InternalMessage[] = [
    ...systemMsgs,
    {
      role: "user" as const,
      content:
        `[以下是对话历史摘要，涵盖此前 ${toCompress.length} 条消息]\n\n${summary}`,
    },
    {
      role: "assistant" as const,
      content: "已了解之前的对话历史，请继续。",
    },
    ...toKeep,
  ]

  return { messages: compacted, summary, savedMessages: toCompress.length }
}
