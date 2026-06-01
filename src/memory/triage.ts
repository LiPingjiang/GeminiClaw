import type { Provider, Message } from "../providers/types.js"
import type { TopicSummary } from "./router.js"

export type TriageResult =
  | { action: "skip" }
  | { action: "new_topic"; title: string; summary: string }
  | { action: "merge_topic"; topicId: string }

interface TriageConfig {
  triageAfterTurns: number
}

const TRIAGE_SYSTEM_PROMPT = `你是一个对话立项助手。
给定一段对话历史和当前活跃事项列表，判断这段对话是否值得建立或归入一个事项。

输出严格的 JSON，格式为以下三种之一：
1. 不值得立项（闲聊/单次问答）：{ "action": "skip" }
2. 归入已有事项：{ "action": "merge_topic", "topicId": "<id>" }
3. 创建新事项：{ "action": "new_topic", "title": "<动作+对象，20字内>", "summary": "<2-3句摘要>" }

规则：
- 标题格式：动作 + 对象，例如"GeminiClaw 记忆系统设计"、"Spark AQE 调优分析"
- 闲聊、单次问答、确认类消息 → skip
- 只输出 JSON，不要解释`

// triage 时只看最近 N 条有效对话（user + assistant，过滤空 content 和 tool 消息）
const TRIAGE_RECENT_TURNS = 20

export class TriageService {
  private provider: Provider
  private threshold: number

  constructor(provider: Provider, config: TriageConfig) {
    this.provider = provider
    this.threshold = config.triageAfterTurns
  }

  async triage(
    _sessionId: string,
    messages: Message[],
    activeTopics: TopicSummary[],
  ): Promise<TriageResult> {
    // 轮数 = user 消息数
    const turns = messages.filter(m => m.role === "user").length
    if (turns < this.threshold) {
      return { action: "skip" }
    }

    // 只取 user/assistant 消息，过滤 tool 消息和空 content，取最近 TRIAGE_RECENT_TURNS 条
    const relevant = messages
      .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim().length > 0)
      .slice(-TRIAGE_RECENT_TURNS)

    if (relevant.length === 0) {
      return { action: "skip" }
    }

    const historyText = relevant
      .map(m => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
      .join("\n")

    const topicsText = activeTopics.length > 0
      ? `\n当前活跃事项：\n` + activeTopics.map(t => `- [${t.id}] ${t.title}`).join("\n")
      : ""

    const userPrompt = `对话历史（最近 ${relevant.length} 条）：\n${historyText}${topicsText}`

    const msgs: Message[] = [
      { role: "system", content: TRIAGE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ]

    try {
      const resp = await this.provider.chat(msgs, { maxTokens: 256, temperature: 0 })
      const parsed = JSON.parse(resp.content) as TriageResult
      if (!parsed.action) return { action: "skip" }
      return parsed
    } catch (err) {
      process.stderr.write(`[triage] LLM call failed, skipping: ${err}\n`)
      return { action: "skip" }
    }
  }
}
