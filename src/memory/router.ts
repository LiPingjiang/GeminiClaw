import type { Provider, Message } from "../providers/types.js"

export interface TopicSummary {
  id: string
  title: string
  summary: string | null
}

export interface TopicMatch {
  topicId: string
  confidence: number
  level: 1 | 2 | 3   // 建议加载的文档层级
}

export interface RouteResult {
  matches: TopicMatch[]
  confidence: number  // 整体置信度（最高 match 的置信度，无 match 时为 0）
}

const ROUTE_SYSTEM_PROMPT = `你是一个对话主题路由助手。
给定用户的最新消息、最近的对话历史、以及一组活跃事项列表，
判断本次消息与哪些事项相关，以及需要加载的文档详细程度（1=摘要/2=概览/3=详情）。

输出严格的 JSON，格式如下：
{
  "matches": [
    { "topicId": "<id>", "confidence": 0.0-1.0, "level": 1|2|3 }
  ],
  "confidence": 0.0-1.0
}

规则：
- 若消息与事项无关（闲聊/单次问答），返回 { "matches": [], "confidence": 0 }
- confidence < 0.7 时 level 最高取 2
- 最多返回 3 个 match
- 只输出 JSON，不要解释`

export class TopicRouter {
  private provider: Provider

  constructor(provider: Provider) {
    this.provider = provider
  }

  async route(
    userMessage: string,
    recentHistory: Message[],
    activeTopics: TopicSummary[],
  ): Promise<RouteResult> {
    if (activeTopics.length === 0) {
      return { matches: [], confidence: 0 }
    }

    const topicsText = activeTopics
      .map(t => `- [${t.id}] ${t.title}：${t.summary ?? "（无摘要）"}`)
      .join("\n")

    const historyText = recentHistory
      .slice(-3)
      .map(m => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
      .join("\n")

    const userPrompt = [
      historyText ? `最近对话：\n${historyText}\n` : "",
      `当前消息：${userMessage}`,
      `\n活跃事项列表：\n${topicsText}`,
    ].join("")

    const messages: Message[] = [
      { role: "system", content: ROUTE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ]

    try {
      const resp = await this.provider.chat(messages, { maxTokens: 512, temperature: 0 })
      const parsed = JSON.parse(resp.content) as RouteResult
      return {
        matches: Array.isArray(parsed.matches) ? parsed.matches : [],
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      }
    } catch {
      return { matches: [], confidence: 0 }
    }
  }
}
