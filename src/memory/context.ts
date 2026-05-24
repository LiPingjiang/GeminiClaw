// src/memory/context.ts
import type { Message } from "../providers/types.js"
import type { TopicSummary } from "./router.js"

export interface TopicDoc {
  topicId: string
  title: string
  level: 1 | 2 | 3
  content: string
}

export interface BuildContextOptions {
  systemPrompt: string
  /** 永久区：注入在 system prompt 之后、话题文档之前，每次重建，永不压缩 */
  pinnedMessages?: Message[]
  activeTopics: TopicSummary[]
  topicDocs: TopicDoc[]
  recentHistory: Message[]
  userMessage: string
  recentMessageLimit: number
}

export function buildContext(opts: BuildContextOptions): Message[] {
  const { systemPrompt, activeTopics, topicDocs, recentHistory, recentMessageLimit } = opts
  const result: Message[] = []

  // 1. system prompt + 活跃事项索引
  let systemContent = systemPrompt
  if (activeTopics.length > 0) {
    const indexText = activeTopics
      .map(t => `- [${t.id}] ${t.title}：${t.summary ?? "（无摘要）"}`)
      .join("\n")
    systemContent += `\n\n## 当前活跃事项（${activeTopics.length} 个）\n${indexText}`
  }
  result.push({ role: "system", content: systemContent })

  // 2. 永久区：Agent 自知 + 协作规则 + 其他 Agent
  if (opts.pinnedMessages && opts.pinnedMessages.length > 0) {
    result.push(...opts.pinnedMessages)
  }

  // 3. 相关事项文档（按需，每个事项一条 system 消息）
  for (const doc of topicDocs) {
    result.push({
      role: "system",
      content: `## 事项详情：${doc.title}（第${doc.level}级）\n${doc.content}`,
    })
  }

  // 3. 近期对话（滑动窗口）
  const trimmed = recentHistory.slice(-recentMessageLimit)
  result.push(...trimmed)

  return result
}
