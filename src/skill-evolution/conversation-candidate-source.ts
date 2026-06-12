/**
 * ConversationCandidateSource — feeds real conversations into the skill engine.
 *
 * This is the skill-engine analogue of twin-system's ConversationIntentSource.
 * It scans a batch of real conversations and returns ReflectionCandidates
 * carrying the (compressed) real transcript.
 *
 * Design note (Hermes-aligned, 2025 refactor):
 *   The previous version did TWO things that hurt reflection quality:
 *     1. It fed the reflector only the LAST 16 messages of each conversation
 *        (a tail fragment), so long multi-step tasks lost their head/middle.
 *     2. It tried to pre-judge "worth reflecting on" with brittle keyword
 *        heuristics (short-response ratio, error markers, repeat detection).
 *   Both are now fixed:
 *     1. renderSample → compressTranscript: the WHOLE conversation is given to
 *        the reflector. Long conversations are compressed by protecting the
 *        head + a token-budget tail of verbatim turns and LLM-summarising the
 *        middle (mirrors Hermes' context_compressor), instead of truncating.
 *     2. The heuristic scoring is demoted to a cheap *coarse filter* (drop
 *        obvious stubs by message count). The real "is this worth a skill?"
 *        judgement is delegated to the reflector's single LLM call, where it
 *        belongs and where the "do NOT crystallize" guardrails live.
 *
 * Deliberately self-contained (own SQL + filtering) so the skill engine has no
 * dependency on twin-system — the two engines are fully independent.
 *
 * Two modes, exactly like the code engine:
 *   - automatic: scheduler calls collect() with the default lookback window.
 *   - manual:    the scan API constructs an instance with an explicit filter.
 */

import type { Db } from "../db/client.js"
import {
  SessionTaskSegmenter,
  type SegmenterMessage,
  type TaskSegment,
} from "./session-task-segmenter.js"
import type { CandidateSource, LlmClient, LlmMessage, ReflectionCandidate } from "./types.js"

// ── Filter / config ──────────────────────────────────────────────────────────

export interface CandidateScanFilter {
  since?: string
  until?: string
  sessionIds?: string[]
  keyword?: string
  maxCandidates?: number
  /**
   * Hard cap on transcript size handed to the reflector, in messages. The
   * conversation is compressed (head + summarised middle + tail) to fit; it is
   * NOT blindly truncated to the last N.
   */
  maxSampleMessages?: number
}

export interface ConversationCandidateConfig {
  lookbackMs: number
  /**
   * Coarse filter: a session with fewer than this many messages is an obvious
   * stub (a greeting, a one-shot question) and is dropped before the reflector
   * ever sees it. This is the ONLY pre-filter now — quality judgement lives in
   * the reflector's LLM call.
   */
  minMessages: number
  maxCandidates: number
  /** Total messages above which the middle is LLM-summarised instead of kept. */
  compressionThreshold: number
  /** When compressing: verbatim messages to protect at the head. */
  headProtect: number
  /** When compressing: verbatim messages to protect at the tail. */
  tailProtect: number
  /** Hard cap on transcript chars handed to the reflector. */
  maxTranscriptChars: number
  /**
   * Above this many messages a session is treated as a *multi-task* session:
   * instead of compressing it into one lossy whole-session transcript, it is
   * first decomposed into independent tasks (SessionTaskSegmenter) and EACH
   * task becomes its own candidate. Requires an LLM client; without one we
   * fall back to whole-session compression. Set high enough that ordinary
   * sessions still go through the single-candidate path.
   */
  taskSegmentationThreshold: number
}

export const DEFAULT_CANDIDATE_CONFIG: ConversationCandidateConfig = {
  lookbackMs: 24 * 60 * 60 * 1000,
  minMessages: 4,
  maxCandidates: 3,
  compressionThreshold: 40,
  headProtect: 8,
  tailProtect: 16,
  maxTranscriptChars: 12000,
  taskSegmentationThreshold: 120,
}

interface SessionRow {
  id: string
  title: string | null
  message_count: number
}

interface MessageRow {
  /** Monotonic message id; used to slice task ranges. */
  id: number
  role: "user" | "assistant" | "system" | "tool"
  content: string
  created_at: string
  /** Raw JSON of the assistant's tool calls (null for non-assistant rows). */
  tool_calls: string | null
  /** Links a tool result back to the assistant tool_call that produced it. */
  tool_call_id: string | null
}

// ── Source ───────────────────────────────────────────────────────────────────

export class ConversationCandidateSource implements CandidateSource {
  private db: Db
  private config: ConversationCandidateConfig
  private filter: CandidateScanFilter
  /**
   * Optional LLM client. When present, the middle of long conversations is
   * summarised instead of dropped. When absent (e.g. unit tests), we fall back
   * to structural compression (head + tail) with a marker for the gap — no LLM
   * call, fully synchronous-safe.
   */
  private llm?: LlmClient

  constructor(
    db: Db,
    config?: Partial<ConversationCandidateConfig>,
    filter: CandidateScanFilter = {},
    llm?: LlmClient,
  ) {
    this.db = db
    this.config = { ...DEFAULT_CANDIDATE_CONFIG, ...config }
    this.filter = filter
    this.llm = llm
  }

  async collect(): Promise<ReflectionCandidate[]> {
    const sessions = this.selectSessions()
    if (sessions.length === 0) return []

    const maxCandidates = this.filter.maxCandidates ?? this.config.maxCandidates

    // Coarse filter: keep sessions that clear the stub threshold, newest first
    // (selectSessions already sorts by updated_at DESC). No quality scoring —
    // the reflector's LLM call makes that call.
    const kept: SessionRow[] = []
    for (const session of sessions) {
      if (kept.length >= maxCandidates) break
      const count = session.message_count ?? 0
      if (count > 0 && count < this.config.minMessages) continue
      // message_count can be stale/null; verify by loading.
      const messages = this.loadMessages(session.id)
      if (messages.length < this.config.minMessages) continue
      kept.push(session)
    }

    const candidates: ReflectionCandidate[] = []
    for (const session of kept) {
      const messages = this.loadMessages(session.id)
      const sessionTitle = session.title?.trim() || `session ${session.id.slice(0, 8)}`

      // Multi-task path: a very long session is almost never one task. Decompose
      // it into independent tasks and emit ONE candidate per task, each carrying
      // only that task's verbatim message range — no lossy middle summary, and
      // the reflector evaluates one clean goal at a time.
      if (this.shouldSegment(messages)) {
        const taskCandidates = await this.collectTaskCandidates(session.id, sessionTitle, messages)
        if (taskCandidates.length > 0) {
          candidates.push(...taskCandidates)
          continue
        }
        // Segmentation produced nothing (LLM failure / no user turns):
        // fall through to whole-session compression.
      }

      const transcript = await this.compressTranscript(messages)
      candidates.push({
        sessionId: session.id,
        title: sessionTitle,
        // No pre-judged problems anymore; the reflector evaluates the raw
        // conversation. We pass the size as a neutral hint only.
        problems: [],
        transcript,
        // Score is retained for API/back-compat; we use message count as a
        // neutral "richness" hint, not a quality verdict.
        score: messages.length,
      })
    }

    return candidates
  }

  // ── Task decomposition (long sessions → one candidate per task) ─────────────

  /** A session qualifies for task decomposition only with an LLM and enough volume. */
  private shouldSegment(messages: MessageRow[]): boolean {
    return !!this.llm && messages.length >= this.config.taskSegmentationThreshold
  }

  /**
   * Decompose one long session into per-task candidates.
   *
   * Steps:
   *   1. Run SessionTaskSegmenter (distill → day-batch → rolling LLM segment)
   *      to get task id-ranges.
   *   2. For each task, slice the ORIGINAL messages by [startId, endId] and
   *      compress THAT slice (small, so usually verbatim) into a transcript.
   *   3. Emit one ReflectionCandidate per task, tagged with task provenance.
   *
   * Returns [] on any failure so the caller can fall back to whole-session.
   */
  private async collectTaskCandidates(
    sessionId: string,
    sessionTitle: string,
    messages: MessageRow[],
  ): Promise<ReflectionCandidate[]> {
    const segmenter = new SessionTaskSegmenter(this.llm!)
    let tasks: TaskSegment[]
    try {
      tasks = await segmenter.segment(messages as SegmenterMessage[])
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[collectTaskCandidates] segmentation failed for ${sessionId} → fallback`, err)
      return []
    }
    if (tasks.length === 0) return []

    const candidates: ReflectionCandidate[] = []
    for (const task of tasks) {
      const slice = messages.filter((m) => m.id >= task.startId && m.id <= task.endId)
      if (slice.length === 0) continue
      const transcript = await this.compressTranscript(slice)
      // The task goal (summary) is the most reliable, distinct label; fall back
      // to the short title only when no summary was produced.
      const label = task.summary?.trim() || task.title
      candidates.push({
        sessionId,
        title: `${sessionTitle} · 任务${task.index}/${tasks.length}: ${label}`,
        problems: [],
        transcript,
        score: slice.length,
        task: {
          index: task.index,
          total: tasks.length,
          title: task.title,
          summary: task.summary,
          startId: task.startId,
          endId: task.endId,
        },
      })
    }
    return candidates
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
      SELECT id, role, content, created_at, tool_calls, tool_call_id
      FROM chat_messages
      WHERE session_id = ?
      ORDER BY id ASC
    `)
    return stmt.all(sessionId) as MessageRow[]
  }

  // ── Transcript compression (Hermes-style) ──────────────────────────────────
  //
  // Goal: give the reflector the WHOLE task, not a tail fragment. For short
  // conversations we render everything. For long ones we protect the head
  // (where the task is framed) and a generous tail (where it concludes),
  // verbatim, and replace the middle with an LLM summary (or a structural
  // marker if no LLM is available). This mirrors Hermes' context_compressor:
  // protect head + token-budget tail + summarise middle.

  private async compressTranscript(messages: MessageRow[]): Promise<string> {
    if (messages.length === 0) return ""

    const { compressionThreshold, headProtect, tailProtect, maxTranscriptChars } = this.config

    // Short enough to keep whole.
    if (messages.length <= compressionThreshold) {
      return this.fitToChars(messages.map((m) => this.renderLine(m)).join("\n"), maxTranscriptChars)
    }

    const head = messages.slice(0, headProtect)
    const tail = messages.slice(messages.length - tailProtect)
    const middle = messages.slice(headProtect, messages.length - tailProtect)

    const headText = head.map((m) => this.renderLine(m)).join("\n")
    const tailText = tail.map((m) => this.renderLine(m)).join("\n")
    const middleSummary = await this.summariseMiddle(middle)

    const assembled = [
      headText,
      "",
      `─── [middle of conversation compressed: ${middle.length} message(s)] ───`,
      middleSummary,
      `─── [end of compressed middle] ───`,
      "",
      tailText,
    ].join("\n")

    return this.fitToChars(assembled, maxTranscriptChars)
  }

  /**
   * Summarise the middle stretch of a long conversation.
   *
   * Pipeline (mirrors Hermes ContextCompressor):
   *   Phase 1 — cheap pre-pass, NO LLM call (`prunePrePass`): dedupe identical
   *             tool results, one-line stale tool output, hard-cap each message
   *             body. This alone collapses the bulk of a 5000-msg middle.
   *   Phase 2 — LLM summary of the pruned text. When no LLM is injected (unit
   *             tests) we return the pruned skeleton as-is.
   *
   * The pre-pass is what keeps us from blowing the summary model's context
   * window: a raw 1.4 M-char middle (4998 msgs) is mostly repeated greps and
   * duplicate tool reads, and pruning removes them before the LLM ever sees it.
   */
  private async summariseMiddle(middle: MessageRow[]): Promise<string> {
    if (middle.length === 0) return "(no middle section)"

    // Phase 1: cheap pre-pass (no LLM).
    const pruned = this.prunePrePass(middle)
    const skeleton = pruned.join("\n")
    // eslint-disable-next-line no-console
    console.error(
      `[summariseMiddle] pre-pass: ${middle.length} msgs → ${pruned.length} lines, ${skeleton.length} chars`,
    )

    if (!this.llm) {
      // eslint-disable-next-line no-console
      console.error(`[summariseMiddle] NO LLM injected → returning pruned skeleton`)
      return skeleton
    }

    const prompt: LlmMessage[] = [
      {
        role: "system",
        content: [
          "You are compressing the MIDDLE of a long agent conversation so a",
          "reflector can later judge whether it contains a reusable skill.",
          "Preserve the task's spine: what the user wanted, what approaches were",
          "tried, which failed and WHY, what finally worked, and any non-obvious",
          "technique, command, gotcha, or correction the user made.",
          "Drop chit-chat, redundant restatements, and verbose tool output.",
          "Write a tight factual summary (bullet points allowed). Do NOT invent.",
        ].join("\n"),
      },
      { role: "user", content: `Summarise this conversation middle:\n\n${skeleton}` },
    ]

    try {
      // eslint-disable-next-line no-console
      console.error(`[summariseMiddle] calling LLM.chat (prompt user=${skeleton.length} chars) ...`)
      const t0 = Date.now()
      const out = await this.llm.chat(prompt)
      // eslint-disable-next-line no-console
      console.error(`[summariseMiddle] LLM.chat returned in ${Date.now() - t0}ms → out=${out.length} chars`)
      const trimmed = out.trim()
      return trimmed.length > 0 ? trimmed : "(summary unavailable)"
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[summariseMiddle] LLM.chat THREW → returning pruned skeleton. error:`, err)
      // On any LLM error, fall back to the (already pruned) structural skeleton
      // rather than the raw middle — the pre-pass output is the safe fallback.
      return skeleton
    }
  }

  // ── Phase 1: Hermes-style cheap pre-pass (no LLM) ───────────────────────────

  /** Max chars kept per message body before the LLM sees it. */
  private static readonly CONTENT_MAX = 6000
  private static readonly CONTENT_HEAD = 4000
  private static readonly CONTENT_TAIL = 1500

  /**
   * Cheap, LLM-free reduction of the conversation middle. Mirrors Hermes
   * `_prune_old_tool_results` + `_serialize_for_summary`:
   *
   *   1. Deduplicate identical tool results — reading the same file or running
   *      the same grep N times keeps the newest copy and replaces the rest with
   *      a one-line back-reference. This is the single biggest win on agent
   *      conversations that loop (the 5022-msg session had a grep repeated 15×).
   *   2. One-line every tool result down to `[tool] <first line> (N chars)` so
   *      verbose output never dominates the summariser input.
   *   3. Hard-cap every remaining message body to CONTENT_MAX (head + tail).
   *
   * Returns one rendered line per surviving message.
   */
  private prunePrePass(middle: MessageRow[]): string[] {
    // Pass A: identify duplicate tool results (walk backward, keep newest).
    const seen = new Set<string>()
    const isDuplicate = new Array<boolean>(middle.length).fill(false)
    for (let i = middle.length - 1; i >= 0; i--) {
      const m = middle[i]
      if (m.role !== "tool") continue
      const key = this.contentHash(m.content)
      if (seen.has(key)) {
        isDuplicate[i] = true
      } else {
        seen.add(key)
      }
    }

    // Pass B: render each surviving message as a single capped line.
    const lines: string[] = []
    for (let i = 0; i < middle.length; i++) {
      const m = middle[i]
      if (m.role === "tool") {
        if (isDuplicate[i]) {
          lines.push(`[tool] (duplicate of an earlier identical result — elided)`)
          continue
        }
        lines.push(this.oneLineTool(m))
        continue
      }
      // user / assistant / system: cap the body, keep tool-call shape hint.
      const capped = this.capContent(m.content)
      const callHint = this.toolCallHint(m)
      lines.push(`[${m.role}] ${capped}${callHint}`)
    }
    return lines
  }

  /** Stable key for dedup: collapses whitespace so trivially-different copies match. */
  private contentHash(content: string): string {
    return content.replace(/\s+/g, " ").trim()
  }

  /** Collapse a (non-duplicate) tool result to a single informative line. */
  private oneLineTool(m: MessageRow): string {
    const text = m.content.trim()
    const firstLine = text.split("\n")[0] ?? ""
    const head = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine
    const lineCount = text.length === 0 ? 0 : text.split("\n").length
    return `[tool] ${head} (${m.content.length} chars, ${lineCount} lines)`
  }

  /** Append a compact "[+N tool call(s)]" hint for assistant turns. */
  private toolCallHint(m: MessageRow): string {
    if (m.role !== "assistant" || !m.tool_calls) return ""
    try {
      const calls = JSON.parse(m.tool_calls)
      if (Array.isArray(calls) && calls.length > 0) {
        const names = calls
          .map((c: any) => c?.function?.name ?? c?.name ?? "?")
          .slice(0, 4)
          .join(", ")
        return ` [tool calls: ${names}${calls.length > 4 ? ", …" : ""}]`
      }
    } catch {
      /* malformed JSON — ignore the hint */
    }
    return ""
  }

  /** Hard-cap a message body to CONTENT_MAX (head + tail), Hermes-style. */
  private capContent(content: string): string {
    const text = content.trim()
    if (text.length <= ConversationCandidateSource.CONTENT_MAX) return text
    return (
      text.slice(0, ConversationCandidateSource.CONTENT_HEAD) +
      "\n…[truncated]…\n" +
      text.slice(text.length - ConversationCandidateSource.CONTENT_TAIL)
    )
  }

  private renderLine(m: MessageRow): string {
    const content = m.content.length > 1500 ? `${m.content.slice(0, 1500)}…` : m.content
    return `[${m.role}] ${content}`
  }

  private fitToChars(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text
    // Keep the tail (conclusion) preferentially — that is where resolution and
    // the final working approach live.
    const keepTail = Math.floor(maxChars * 0.6)
    const keepHead = maxChars - keepTail
    return (
      text.slice(0, keepHead) +
      `\n…(${text.length - maxChars} chars elided)…\n` +
      text.slice(text.length - keepTail)
    )
  }

  private toSqliteTime(ms: number): string {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19)
  }
}
