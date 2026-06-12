/**
 * ConversationCandidateSource — feeds real conversations into the skill engine.
 *
 * This is the skill-engine analogue of twin-system's ConversationIntentSource.
 * It scans a batch of real conversations, scores each for "worth reflecting on"
 * (quality problems OR rich multi-step task content), and returns
 * ReflectionCandidates carrying the real transcript.
 *
 * Deliberately self-contained (own SQL + scoring) so the skill engine has no
 * dependency on twin-system — the two engines are fully independent.
 *
 * Two modes, exactly like the code engine:
 *   - automatic: scheduler calls collect() with the default lookback window.
 *   - manual:    the scan API constructs an instance with an explicit filter.
 */

import type { Db } from "../db/client.js"
import type { CandidateSource, ReflectionCandidate } from "./types.js"

// ── Filter / config ──────────────────────────────────────────────────────────

export interface CandidateScanFilter {
  since?: string
  until?: string
  sessionIds?: string[]
  keyword?: string
  maxCandidates?: number
  maxSampleMessages?: number
}

export interface ConversationCandidateConfig {
  lookbackMs: number
  shortResponseThreshold: number
  minScore: number
  maxCandidates: number
  maxSampleMessages: number
  errorMarkers: string[]
  /** A conversation with >= this many user turns is "rich" and worth a skill. */
  richConversationTurns: number
}

export const DEFAULT_CANDIDATE_CONFIG: ConversationCandidateConfig = {
  lookbackMs: 24 * 60 * 60 * 1000,
  shortResponseThreshold: 50,
  minScore: 1,
  maxCandidates: 3,
  maxSampleMessages: 16,
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
  richConversationTurns: 5,
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

interface Analysis {
  score: number
  reasons: string[]
}

// ── Source ───────────────────────────────────────────────────────────────────

export class ConversationCandidateSource implements CandidateSource {
  private db: Db
  private config: ConversationCandidateConfig
  private filter: CandidateScanFilter

  constructor(
    db: Db,
    config?: Partial<ConversationCandidateConfig>,
    filter: CandidateScanFilter = {},
  ) {
    this.db = db
    this.config = { ...DEFAULT_CANDIDATE_CONFIG, ...config }
    this.filter = filter
  }

  collect(): ReflectionCandidate[] {
    const sessions = this.selectSessions()
    if (sessions.length === 0) return []

    const maxCandidates = this.filter.maxCandidates ?? this.config.maxCandidates
    const scored: Array<{ session: SessionRow; analysis: Analysis; messages: MessageRow[] }> = []

    for (const session of sessions) {
      const messages = this.loadMessages(session.id)
      if (messages.length === 0) continue
      const analysis = this.analyze(messages)
      if (analysis.score >= this.config.minScore) {
        scored.push({ session, analysis, messages })
      }
    }

    scored.sort((a, b) => b.analysis.score - a.analysis.score)

    return scored.slice(0, maxCandidates).map(({ session, analysis, messages }) => ({
      sessionId: session.id,
      title: session.title?.trim() || `session ${session.id.slice(0, 8)}`,
      problems: analysis.reasons,
      transcript: this.renderSample(messages),
      score: analysis.score,
    }))
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

    const since =
      this.filter.since ??
      (this.filter.sessionIds && this.filter.sessionIds.length > 0
        ? undefined
        : this.toSqliteTime(Date.now() - this.config.lookbackMs))
    if (since) {
      clauses.push(`s.id IN (SELECT session_id FROM chat_messages WHERE created_at >= ?)`)
      params.push(since)
    }
    if (this.filter.until) {
      clauses.push(`s.id IN (SELECT session_id FROM chat_messages WHERE created_at <= ?)`)
      params.push(this.filter.until)
    }
    if (this.filter.keyword) {
      clauses.push(`s.id IN (SELECT session_id FROM chat_messages WHERE content LIKE ?)`)
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

  // ── Scoring ────────────────────────────────────────────────────────────────
  //
  // Unlike the code engine (which only looks for *problems*), the skill engine
  // also values *rich, successful* task conversations — those are the best
  // source of reusable playbooks to crystallise.

  private analyze(messages: MessageRow[]): Analysis {
    const reasons: string[] = []
    let score = 0

    const assistantMsgs = messages.filter((m) => m.role === "assistant")
    const userMsgs = messages.filter((m) => m.role === "user")

    // 1. Short assistant responses (quality problem → lesson to encode).
    const shortCount = assistantMsgs.filter(
      (m) => m.content.trim().length < this.config.shortResponseThreshold,
    ).length
    if (assistantMsgs.length > 0 && shortCount / assistantMsgs.length >= 0.5) {
      score += 1
      reasons.push(
        `${shortCount}/${assistantMsgs.length} assistant responses were very short (<${this.config.shortResponseThreshold} chars)`,
      )
    }

    // 2. Error/refusal markers.
    const errorHits = assistantMsgs.filter((m) => {
      const lower = m.content.toLowerCase()
      return this.config.errorMarkers.some((marker) => lower.includes(marker))
    }).length
    if (errorHits > 0) {
      score += errorHits >= 2 ? 2 : 1
      reasons.push(`${errorHits} assistant message(s) contained error/refusal markers`)
    }

    // 3. User had to repeat themselves.
    const userCounts = new Map<string, number>()
    for (const m of userMsgs) {
      const key = m.content.trim().slice(0, 60).toLowerCase()
      if (key.length < 8) continue
      userCounts.set(key, (userCounts.get(key) ?? 0) + 1)
    }
    const maxRepeat = Math.max(0, ...userCounts.values())
    if (maxRepeat >= 2) {
      score += 1
      reasons.push(`User repeated the same request ${maxRepeat} times`)
    }

    // 4. Rich multi-step conversation → crystallise into a reusable playbook.
    if (userMsgs.length >= this.config.richConversationTurns) {
      score += 1
      reasons.push(
        `Rich multi-step task (${userMsgs.length} user turns) — good candidate for a reusable skill`,
      )
    }

    return { score, reasons }
  }

  // ── Sample rendering ───────────────────────────────────────────────────────

  private renderSample(messages: MessageRow[]): string {
    const cap = this.filter.maxSampleMessages ?? this.config.maxSampleMessages
    const slice = messages.slice(-cap)
    const omitted = messages.length - slice.length
    const lines = slice.map((m) => {
      const content = m.content.length > 1000 ? `${m.content.slice(0, 1000)}…` : m.content
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
