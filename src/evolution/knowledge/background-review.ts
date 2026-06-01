/**
 * src/evolution/knowledge/background-review.ts
 * BackgroundReviewer — 第 1 层知识进化：每轮对话后实时学习
 *
 * 触发：每次对话结束（on_session_end hook）
 * 机制：spawn 后台 LLM 调用（复用 ProviderRouter + prompt cache）
 *       分析对话上下文，提取值得持久化的知识条目
 * 工具白名单：仅 KnowledgeStore.add / KnowledgeStore.update
 * 防护：禁递归、anti-pattern 过滤、置信度阈值
 */

import { KnowledgeStore, type KnowledgeCategory } from "./store.js"
import {
  buildReviewSystemPrompt,
  buildReviewUserMessage,
  parseReviewResponse,
  type ReviewResult,
} from "./rubric.js"

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReviewerConfig {
  /** Minimum confidence to persist knowledge (default 0.6) */
  minConfidence: number
  /** Maximum knowledge items to extract per turn (default 3) */
  maxItemsPerTurn: number
  /** Whether to run reviews (can be disabled for testing) */
  enabled: boolean
  /** Cooldown between reviews in ms (prevent spam, default 5000) */
  cooldownMs: number
}

const DEFAULT_CONFIG: ReviewerConfig = {
  minConfidence: 0.6,
  maxItemsPerTurn: 3,
  enabled: true,
  cooldownMs: 5000,
}

export interface TurnContext {
  sessionId: string
  turnIndex: number
  userMessage: string
  assistantResponse: string
  toolCalls?: Array<{ name: string; result: string }>
}

export interface ChatFunction {
  (messages: Array<{ role: string; content: string }>): Promise<{ content: string }>
}

// ── BackgroundReviewer ───────────────────────────────────────────────────────

export class BackgroundReviewer {
  private store: KnowledgeStore
  private chatFn: ChatFunction
  private config: ReviewerConfig
  private lastReviewAt = 0
  private reviewCount = 0
  private _running = false

  constructor(params: {
    store: KnowledgeStore
    chatFn: ChatFunction
    config?: Partial<ReviewerConfig>
  }) {
    this.store = params.store
    this.chatFn = params.chatFn
    this.config = { ...DEFAULT_CONFIG, ...params.config }
  }

  /**
   * Whether the reviewer is currently processing.
   */
  get isRunning(): boolean {
    return this._running
  }

  /**
   * Total reviews completed.
   */
  get totalReviews(): number {
    return this.reviewCount
  }

  /**
   * Review a conversation turn and extract knowledge.
   * This is fire-and-forget — errors are caught internally.
   *
   * Returns the extracted knowledge items (or empty array on failure/skip).
   */
  async review(turn: TurnContext): Promise<ReviewResult[]> {
    if (!this.config.enabled) return []

    // Cooldown check
    const now = Date.now()
    if (now - this.lastReviewAt < this.config.cooldownMs) {
      return []
    }

    // Skip trivially short turns
    if (turn.userMessage.length < 10 && turn.assistantResponse.length < 50) {
      return []
    }

    this._running = true
    this.lastReviewAt = now

    try {
      const results = await this.executeReview(turn)
      this.reviewCount++
      return results
    } catch (err) {
      console.error("[BackgroundReviewer] Review failed:", err)
      return []
    } finally {
      this._running = false
    }
  }

  /**
   * Internal: call LLM and process results.
   */
  private async executeReview(turn: TurnContext): Promise<ReviewResult[]> {
    const systemPrompt = buildReviewSystemPrompt()
    const userPrompt = buildReviewUserMessage({
      userMessage: turn.userMessage,
      assistantResponse: turn.assistantResponse,
      toolCalls: turn.toolCalls,
    })

    // Call LLM
    const response = await this.chatFn([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ])

    // Parse response
    const items = parseReviewResponse(response.content)

    // Filter by confidence threshold and cap count
    const qualified = items
      .filter((item) => item.confidence >= this.config.minConfidence)
      .slice(0, this.config.maxItemsPerTurn)

    // Persist to knowledge store
    for (const item of qualified) {
      // Check for duplicates
      const similar = this.store.findSimilar(item.content)
      if (similar.length > 0) {
        // Update existing entry's confidence if this is a reinforcement
        const existing = similar[0]
        const newConfidence = Math.min(1.0, existing.confidence + 0.1)
        this.store.update(existing.id, { confidence: newConfidence })
        continue
      }

      // Validate category
      const validCategories: KnowledgeCategory[] = [
        "user_preference", "behavioral_pattern", "domain_knowledge",
        "technique", "correction",
      ]
      const category = validCategories.includes(item.category as KnowledgeCategory)
        ? (item.category as KnowledgeCategory)
        : "domain_knowledge"

      this.store.add({
        content: item.content,
        category,
        source: {
          sessionId: turn.sessionId,
          turnIndex: turn.turnIndex,
          timestamp: Date.now(),
        },
        tags: item.tags,
        confidence: item.confidence,
      })
    }

    return qualified
  }

  /**
   * Get current config for diagnostics.
   */
  getConfig(): ReviewerConfig {
    return { ...this.config }
  }

  /**
   * Update config at runtime.
   */
  updateConfig(updates: Partial<ReviewerConfig>): void {
    Object.assign(this.config, updates)
  }
}
