import type { MemoryStrategy, ConversationContext } from '../strategy.js'
import type { Message } from '../../providers/types.js'

export interface CompactionConfig {
  /** 触发阈值（占 contextWindow 的比例），默认 0.75 */
  threshold: number
  /** 模型 context window 大小（token 数），默认 200000 */
  contextWindow: number
  /** 尾部永不压缩的消息数，默认 20 */
  keepLast: number
  /** 生成摘要的函数；existingSummary 为已有摘要（叠加用） */
  summarizeFn: (messages: Message[], existingSummary?: string) => Promise<string>
}

/** token 估算：chars / 4 × 1.2 安全系数 */
function estimateTokens(text: string): number {
  return Math.ceil((text.length / 4) * 1.2)
}

function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => {
    const content =
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    // 也把 tool_calls 序列化计入
    const extra = m.tool_calls ? JSON.stringify(m.tool_calls) : ''
    return sum + estimateTokens(content + extra)
  }, 0)
}

/**
 * 找到安全切分点：不在 tool call / result 配对中间切断。
 *
 * 规则：从末尾保留 keepLast 条消息；若第一条是 tool result（role='tool'），
 * 则向前扩展，直到包含发起该调用的 assistant 消息为止。
 */
function findSafeCutPoint(messages: Message[], keepLast: number): number {
  let startIdx = Math.max(0, messages.length - keepLast)

  // 向前移动，确保不从 tool result 开始（必须包含配对的 assistant）
  while (startIdx > 0 && messages[startIdx].role === 'tool') {
    startIdx--
  }

  return startIdx
}

/**
 * CompactionStrategy — Decorator Pattern
 *
 * 包裹任何 MemoryStrategy（如 SqliteStrategy / BufferStrategy），
 * 在 context 超过阈值时自动压缩历史消息为摘要，采用三段式结构：
 *   [系统人格] + [SUMMARY 叠加摘要（assistant）] + [最近 keepLast 条消息]
 *
 * AgentLoop 对此完全透明，不感知。
 */
export class CompactionStrategy implements MemoryStrategy {
  readonly name = 'compaction'

  /** sessionId → 当前累积摘要文本 */
  private summaries: Map<string, string> = new Map()

  constructor(
    private readonly inner: MemoryStrategy,
    private readonly config: CompactionConfig,
  ) {}

  async ensureSession(sessionId: string): Promise<void> {
    return this.inner.ensureSession(sessionId)
  }

  async getContext(sessionId: string, userMessage: string): Promise<ConversationContext> {
    const ctx = await this.inner.getContext(sessionId, userMessage)
    const summary = this.summaries.get(sessionId)

    if (!summary) return ctx

    // 三段式中间段：把摘要注入为第一条 assistant 消息
    const summaryMsg: Message = {
      role: 'assistant',
      content: `[SUMMARY]\n${summary}`,
    }

    return {
      ...ctx,
      messages: [summaryMsg, ...ctx.messages],
    }
  }

  async appendTurn(
    sessionId: string,
    userMsg: Message,
    assistantMsg: Message,
  ): Promise<void> {
    await this.inner.appendTurn(sessionId, userMsg, assistantMsg)
    await this.maybeCompact(sessionId)
  }

  async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this.inner.appendMessages(sessionId, messages)
    await this.maybeCompact(sessionId)
  }

  // ── private ────────────────────────────────────────────────────────────────

  private async maybeCompact(sessionId: string): Promise<void> {
    const ctx = await this.inner.getContext(sessionId, '')
    const messages = ctx.messages

    const totalTokens = estimateMessagesTokens(messages)
    const triggerThreshold = Math.floor(
      this.config.contextWindow * this.config.threshold,
    )

    if (totalTokens < triggerThreshold) return

    console.log(
      `[Compaction] session=${sessionId} tokens≈${totalTokens} >= threshold=${triggerThreshold}, compacting...`,
    )

    // 找到安全切分点：尾部保留 keepLast 条
    const cutPoint = findSafeCutPoint(messages, this.config.keepLast)
    const toSummarize = messages.slice(0, cutPoint)

    if (toSummarize.length === 0) {
      console.warn(`[Compaction] session=${sessionId} nothing to compact (all messages in keepLast window)`)
      return
    }

    // 生成新摘要（叠加旧摘要）
    const existingSummary = this.summaries.get(sessionId)
    const newSummary = await this.config.summarizeFn(toSummarize, existingSummary)
    this.summaries.set(sessionId, newSummary)

    console.log(
      `[Compaction] session=${sessionId} compressed ${toSummarize.length} messages into summary`,
    )
  }
}
