/**
 * src/evolution/knowledge/rubric.ts
 * Review Rubric — LLM 评审维度（移植自 Hermes prompt 工程）
 *
 * 定义了"什么值得学习"和"什么不该学习"的评审准则，
 * 用于指导 BackgroundReviewer 的 LLM 调用。
 */

// ── Anti-patterns (不应保存的知识) ─────────────────────────────────────────

export const ANTI_PATTERNS = [
  "环境特定的一次性错误（如 node_modules 缺失、网络超时）",
  "工具执行的中间输出或临时文件路径",
  "一次性叙事性内容（'用户今天很忙'、'系统很慢'）",
  "工具的否定断言（'X 工具不存在'——可能只是当时环境问题）",
  "重复的、已被更具体知识覆盖的泛化描述",
  "包含敏感信息（密码、token、个人隐私）",
  "过于琐碎的操作细节（'用户打开了文件 X'）",
  "用户明确表示不想被记住的内容",
] as const

// ── What to learn (值得学习的内容) ────────────────────────────────────────

export const LEARNING_PRIORITIES = [
  { priority: 1, category: "user_preference", description: "用户明确表达的偏好（编码风格、命名规范、工具选择等）" },
  { priority: 2, category: "correction", description: "用户纠正了 Agent 的错误（说明 Agent 有误解需要修正）" },
  { priority: 3, category: "behavioral_pattern", description: "用户反复执行的工作流模式（可以主动提供快捷方式）" },
  { priority: 4, category: "domain_knowledge", description: "业务领域概念或架构决策（帮助后续对话理解上下文）" },
  { priority: 5, category: "technique", description: "新发现的技术技巧或最佳实践（扩充 Agent 知识库）" },
] as const

// ── Review Prompt Template ───────────────────────────────────────────────────

/**
 * Generate the system prompt for the background reviewer.
 */
export function buildReviewSystemPrompt(): string {
  return `You are a Knowledge Reviewer analyzing a conversation turn to extract learnable knowledge.

## Your Task
Review the conversation and identify any knowledge worth persisting for future sessions.

## What TO Learn (priority order):
${LEARNING_PRIORITIES.map((p) => `${p.priority}. [${p.category}] ${p.description}`).join("\n")}

## What NOT TO Learn (anti-patterns):
${ANTI_PATTERNS.map((p) => `- ${p}`).join("\n")}

## Output Format
Return a JSON array of knowledge items. Each item:
{
  "content": "concise description of the knowledge (1-2 sentences)",
  "category": "user_preference|behavioral_pattern|domain_knowledge|technique|correction",
  "tags": ["relevant", "tags"],
  "confidence": 0.0-1.0 (how certain you are this is valuable),
  "reasoning": "brief explanation of why this is worth learning"
}

If nothing is worth learning from this turn, return an empty array: []

## Rules
- Be SELECTIVE. Quality over quantity. Most turns produce 0-1 knowledge items.
- Be CONCISE. Knowledge should be actionable in 1-2 sentences.
- NEVER extract sensitive information (passwords, tokens, personal data).
- NEVER extract one-time environmental issues.
- Prefer SPECIFIC over generic (e.g., "user prefers snake_case in Python" > "user has coding preferences").
- If the user corrects the agent, capture WHAT was wrong and WHAT is correct.`
}

/**
 * Build the user message for the reviewer, containing the conversation turn context.
 */
export function buildReviewUserMessage(params: {
  userMessage: string
  assistantResponse: string
  toolCalls?: Array<{ name: string; result: string }>
  sessionContext?: string
}): string {
  let msg = `## Conversation Turn to Review

### User Message:
${params.userMessage}

### Assistant Response:
${params.assistantResponse}`

  if (params.toolCalls && params.toolCalls.length > 0) {
    msg += `\n\n### Tool Calls:`
    for (const tc of params.toolCalls.slice(0, 5)) {
      msg += `\n- ${tc.name}: ${tc.result.slice(0, 200)}`
    }
  }

  if (params.sessionContext) {
    msg += `\n\n### Session Context:\n${params.sessionContext}`
  }

  msg += `\n\n---\nExtract learnable knowledge from this turn. Return JSON array.`
  return msg
}

// ── Response Parser ──────────────────────────────────────────────────────────

export interface ReviewResult {
  content: string
  category: string
  tags: string[]
  confidence: number
  reasoning: string
}

/**
 * Parse the LLM response from the reviewer.
 * Handles both clean JSON and markdown-wrapped JSON.
 */
export function parseReviewResponse(response: string): ReviewResult[] {
  // Try to extract JSON from the response
  let jsonStr = response.trim()

  // Handle markdown code blocks
  const jsonBlock = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonBlock) {
    jsonStr = jsonBlock[1].trim()
  }

  // Handle cases where response starts with text before JSON
  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/)
  if (arrayMatch) {
    jsonStr = arrayMatch[0]
  }

  try {
    const parsed = JSON.parse(jsonStr)
    if (!Array.isArray(parsed)) return []

    // Validate each item
    return parsed.filter((item): item is ReviewResult => {
      return (
        item &&
        typeof item.content === "string" &&
        typeof item.category === "string" &&
        Array.isArray(item.tags) &&
        typeof item.confidence === "number" &&
        item.confidence >= 0 &&
        item.confidence <= 1
      )
    })
  } catch {
    return []
  }
}
