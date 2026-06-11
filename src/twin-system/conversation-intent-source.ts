/**
 * ConversationIntentSource — Conversation-driven evolution intents.
 *
 * Unlike TraceIntentSource (which only produces *aggregate* statistics like
 * "60% of responses are short"), this source scans a *batch of real
 * conversations*, scores each one for quality problems, and packages the
 * actual conversation transcript into the intent's description. This gives the
 * mutator a concrete evidence anchor to reason about — directly addressing the
 * low mutation hit-rate caused by abstract, sample-less intents.
 *
 * This is the GeminiClaw analogue of Hermes' "reflect on a real trajectory"
 * step: we evolve code, but we still anchor the change on a real interaction.
 *
 * Two operating modes:
 *   1. Automatic: the scheduler/cron calls generate() with default filters,
 *      scanning a recent window of conversations.
 *   2. Manual:    the /v1/evolution/scan-conversations API constructs an
 *      instance with explicit ScanFilter (time range / sessionIds / keyword)
 *      to scan a chosen batch and drive an evolution cycle on demand. This is
 *      the test-closed-loop entry point: tweak the logic, then scan a batch of
 *      historical conversations and watch it iterate.
 */

import type { Db } from "../db/client.js"
import type { IntentSource, RawIntent } from "./intent-aggregator.js"

// ── Types ────────────────────────────────────────────────────────────────────

export interface ScanFilter {
  /** Only scan messages created at or after this ISO datetime (SQLite format). */
  since?: string
  /** Only scan messages created at or before this ISO datetime (SQLite format). */
  until?: string
  /** Restrict to specific sessions. */
  sessionIds?: string[]
  /** Only sessions whose any message content contains this substring. */
  keyword?: string
  /** Max number of problematic sessions to turn into intents per scan. */
  maxIntents?: number
  /** Max messages to include per conversation sample (avoids huge prompts). */
  maxSampleMessages?: number
}

export interface ConversationIntentSourceConfig {
  /** Default lookback window in ms for automatic scans (default 24h). */
  lookbackMs: number
  /** Assistant response shorter than this (chars) counts as a quality issue. */
  shortResponseThreshold: number
  /** Minimum problem score for a session to become an intent. */
  minProblemScore: number
  /** Default cap on intents produced per scan. */
  maxIntents: number
  /** Default cap on sampled messages per conversation. */
  maxSampleMessages: number
  /** Keywords in assistant content that signal an error/failure. */
  errorMarkers: string[]
}

export const DEFAULT_CONVERSATION_CONFIG: ConversationIntentSourceConfig = {
  lookbackMs: 24 * 60 * 60 * 1000,
  shortResponseThreshold: 50,
  minProblemScore: 1,
  maxIntents: 3,
  maxSampleMessages: 12,
  errorMarkers: [
    "error",
    "sorry",
    "i cannot",
    "i can't",
    "unable to",
    "failed",
    "出错",
    "无法",
    "抱歉",
    "失败",
    "不能",
  ],
}

interface SessionRow {
  id: string
  title: string | null
  message_count: number
}

interface MessageRow {
  role: "user" | "assistant" | "system"
  content: string
  created_at: string
}

interface ProblemAnalysis {
  score: number
  reasons: string[]
  riskLevel: "low" | "medium"
}

// ── Source ─────────────────────────────────────────────────────────────────

export class ConversationIntentSource implements IntentSource {
  readonly name = "conversation-scan"

  private db: Db
  private config: ConversationIntentSourceConfig
  /** Per-instance override filter (used by the manual scan API). */
  private filter: ScanFilter

  constructor(
    db: Db,
    config?: Partial<ConversationIntentSourceConfig>,
    filter: ScanFilter = {},
  ) {
    this.db = db
    this.config = { ...DEFAULT_CONVERSATION_CONFIG, ...config }
    this.filter = filter
  }

  generate(): RawIntent[] {
    const sessions = this.selectSessions()
    if (sessions.length === 0) return []

    const maxIntents = this.filter.maxIntents ?? this.config.maxIntents
    const scored: Array<{ session: SessionRow; analysis: ProblemAnalysis; messages: MessageRow[] }> = []

    for (const session of sessions) {
      const messages = this.loadMessages(session.id)
      if (messages.length === 0) continue
      const analysis = this.analyzeConversation(messages)
      if (analysis.score >= this.config.minProblemScore) {
        scored.push({ session, analysis, messages })
      }
    }

    // Highest problem score first.
    scored.sort((a, b) => b.analysis.score - a.analysis.score)

    return scored.slice(0, maxIntents).map(({ session, analysis, messages }) =>
      this.buildIntent(session, analysis, messages),
    )
  }

  // ── Session selection ──────────────────────────────────────────────────────

  private selectSessions(): SessionRow[] {
    const clauses: string[] = []
    const params: unknown[] = []

    if (this.filter.sessionIds && this.filter.sessionIds.length > 0) {
      const placeholders = this.filter.sessionIds.map(() => "?").join(", ")
      clauses.push(`s.id IN (${placeholders})`)
      params.push(...this.filter.sessionIds)
    }

    // Time window: explicit `since` wins, otherwise default lookback for auto mode.
    const since =
      this.filter.since ??
      (this.filter.sessionIds && this.filter.sessionIds.length > 0
        ? undefined
        : this.toSqliteTime(Date.now() - this.config.lookbackMs))
    if (since) {
      clauses.push(
        `s.id IN (SELECT session_id FROM chat_messages WHERE created_at >= ?)`,
      )
      params.push(since)
    }
    if (this.filter.until) {
      clauses.push(
        `s.id IN (SELECT session_id FROM chat_messages WHERE created_at <= ?)`,
      )
      params.push(this.filter.until)
    }
    if (this.filter.keyword) {
      clauses.push(
        `s.id IN (SELECT session_id FROM chat_messages WHERE content LIKE ?)`,
      )
      params.push(`%${this.filter.keyword}%`)
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const stmt = this.db.prepare(`
      SELECT s.id, s.title, s.message_count
      FROM chat_sessions s
      ${where}
      ORDER BY s.updated_at DESC
      LIMIT 100
    `)
    return stmt.all(...params) as SessionRow[]
  }

  private loadMessages(sessionId: string): MessageRow[] {
    const stmt = this.db.prepare(`
      SELECT role, content, created_at
      FROM chat_messages
      WHERE session_id = ?
      ORDER BY id ASC
    `)
    return stmt.all(sessionId) as MessageRow[]
  }

  // ── Problem analysis ───────────────────────────────────────────────────────

  private analyzeConversation(messages: MessageRow[]): ProblemAnalysis {
    const reasons: string[] = []
    let score = 0
    let riskLevel: "low" | "medium" = "low"

    const assistantMsgs = messages.filter((m) => m.role === "assistant")
    const userMsgs = messages.filter((m) => m.role === "user")

    // 1. Short assistant responses.
    const shortCount = assistantMsgs.filter(
      (m) => m.content.trim().length < this.config.shortResponseThreshold,
    ).length
    if (assistantMsgs.length > 0 && shortCount / assistantMsgs.length >= 0.5) {
      score += 1
      reasons.push(
        `${shortCount}/${assistantMsgs.length} assistant responses are very short (<${this.config.shortResponseThreshold} chars)`,
      )
    }

    // 2. Error/refusal markers in assistant output.
    const errorHits = assistantMsgs.filter((m) => {
      const lower = m.content.toLowerCase()
      return this.config.errorMarkers.some((marker) => lower.includes(marker))
    }).length
    if (errorHits > 0) {
      score += errorHits >= 2 ? 2 : 1
      if (errorHits >= 2) riskLevel = "medium"
      reasons.push(`${errorHits} assistant message(s) contain error/refusal markers`)
    }

    // 3. User repeating themselves (rephrasing because the agent didn't help).
    const userCounts = new Map<string, number>()
    for (const m of userMsgs) {
      const key = m.content.trim().slice(0, 60).toLowerCase()
      if (key.length < 8) continue
      userCounts.set(key, (userCounts.get(key) ?? 0) + 1)
    }
    const maxRepeat = Math.max(0, ...userCounts.values())
    if (maxRepeat >= 2) {
      score += 1
      reasons.push(`User repeated the same request ${maxRepeat} times (likely unhelpful answers)`)
    }

    // 4. Conversation got long with no resolution (many user turns).
    if (userMsgs.length >= 6 && assistantMsgs.length > 0 && shortCount > 0) {
      score += 1
      reasons.push(`Long conversation (${userMsgs.length} user turns) with low-quality responses`)
    }

    return { score, reasons, riskLevel }
  }

  // ── Intent construction ────────────────────────────────────────────────────

  private buildIntent(
    session: SessionRow,
    analysis: ProblemAnalysis,
    messages: MessageRow[],
  ): RawIntent {
    const sample = this.renderSample(messages)
    const title = session.title?.trim() || `session ${session.id.slice(0, 8)}`

    const description = [
      `A real conversation ("${title}") showed quality problems. Improve the agent so future conversations like this go better.`,
      ``,
      `## Detected problems`,
      ...analysis.reasons.map((r) => `- ${r}`),
      ``,
      `## Conversation transcript (real sample)`,
      sample,
      ``,
      `## What to do`,
      `Analyze the transcript above, identify the root cause in the codebase, and make a minimal, safe code change that would have produced a better interaction. Focus on response quality, error handling, or agent behavior — not cosmetic changes.`,
    ].join("\n")

    return {
      type: "behavior_fix",
      description,
      targetFiles: [
        "src/server/routes/chat.ts",
        "src/providers/router.ts",
        "src/agent/loop.ts",
      ],
      evidence: [
        `Session: ${session.id}`,
        `Problem score: ${analysis.score}`,
        ...analysis.reasons,
      ],
      riskLevel: analysis.riskLevel,
      priority: 0.65 + Math.min(analysis.score * 0.05, 0.2),
      dedupKey: `conversation:${session.id}`,
    }
  }

  private renderSample(messages: MessageRow[]): string {
    const cap = this.filter.maxSampleMessages ?? this.config.maxSampleMessages
    // Keep the most recent `cap` messages to stay within prompt budget.
    const slice = messages.slice(-cap)
    const omitted = messages.length - slice.length
    const lines = slice.map((m) => {
      const content = m.content.length > 800 ? `${m.content.slice(0, 800)}…` : m.content
      return `[${m.role}] ${content}`
    })
    if (omitted > 0) {
      lines.unshift(`… (${omitted} earlier message(s) omitted) …`)
    }
    return lines.join("\n")
  }

  private toSqliteTime(ms: number): string {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19)
  }
}
