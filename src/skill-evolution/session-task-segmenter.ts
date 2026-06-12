/**
 * SessionTaskSegmenter — split a long session into independent *tasks*.
 *
 * Why this exists
 * ---------------
 * A single long-running session (the worst real case observed: 5054 messages
 * over 7.6 days) is almost never ONE task — it is dozens of distinct goals
 * ("fix the data", "add a strategy", "debug the cron", …) interleaved over
 * days. Feeding the whole thing to one reflector is both impossible (≈960K
 * tokens blows every context window) and wrong (a reflector cannot extract one
 * clean skill from 19 unrelated jobs).
 *
 * The fix is a two-stage pipeline that NEVER feeds the raw transcript to an LLM:
 *
 *   Stage 1 — distill (no LLM): keep only the high-signal turns: every human
 *     `user` message + the FINAL user-facing `assistant` reply of each turn
 *     (the intermediate tool-calling steps are dropped). On the 5054-msg
 *     session this collapses 3.85M chars → 153K chars (~89K tokens, 4%).
 *
 *   Stage 2 — segment (LLM): feed the distilled sequence to an LLM and ask it
 *     to draw task boundaries. Organised by day; a batch is capped at
 *     `maxBatchTokens` (default 150K, sized for a 200K window). If the distilled
 *     sequence exceeds the cap it is split into day-aligned batches and the
 *     model is given the task list produced so far so it can *continue* the
 *     numbering across batches (rolling segmentation).
 *
 * Output is a list of `TaskSegment`s, each carrying the message-id range
 * [startId, endId] of that task. The caller slices the ORIGINAL (full) message
 * list by that range to build a small, self-contained transcript per task.
 *
 * Empirically (real data): single-batch segmentation yields the best, coarsest
 * grouping; forced multi-batch works (state carries across batches, ids stay
 * monotonic) but fragments tasks because the model can only see one batch at a
 * time. So: keep the batch cap high enough that one batch is the common case.
 */

import type { LlmClient, LlmMessage } from "./types.js"

export interface SegmenterMessage {
  /** Monotonic message id (chat_messages.id). Tasks are expressed as id ranges. */
  id: number
  role: "user" | "assistant" | "system" | "tool"
  content: string
  /** SQLite timestamp "YYYY-MM-DD HH:MM:SS"; used for day-aligned batching. */
  created_at: string
}

export interface TaskSegment {
  /** 1-based global task index. */
  index: number
  title: string
  summary: string
  /** Inclusive message-id range covering this task. */
  startId: number
  endId: number
  /** How many distilled turns the model assigned to this task (advisory). */
  turnCount: number
}

export interface SegmenterConfig {
  /** Per-batch token cap. Default 150K (leaves headroom in a 200K window). */
  maxBatchTokens: number
  /** Per-call output budget for the segmentation LLM. */
  maxOutputTokens: number
}

export const DEFAULT_SEGMENTER_CONFIG: SegmenterConfig = {
  maxBatchTokens: 150_000,
  maxOutputTokens: 16_000,
}

// ── distilled turn ───────────────────────────────────────────────────────────

interface DistilledTurn {
  id: number
  day: string
  user: string
  finalReply: string
  text: string
  tokens: number
}

const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/

/** Cheap token estimate: CJK ≈ 1.3 tok/char, other ≈ 0.25 tok/char. */
export function estimateTokens(s: string): number {
  let cjk = 0
  let other = 0
  for (const ch of s) {
    if (CJK_RE.test(ch)) cjk++
    else other++
  }
  return Math.round(cjk * 1.3 + other / 4)
}

const norm = (s: string): string => (s || "").replace(/\s+/g, " ").trim()

// NOTE: output format is intentionally a compact, line-oriented "TASK|..." form
// rather than a JSON array. A long JSON array of similarly-shaped task objects
// trips the ProviderRouter's repetition-loop detector (it sees the repeated
// `","startId":`/`","summary":` punctuation as a stuck loop) and gets truncated
// mid-stream, corrupting the payload. One pipe-delimited line per task keeps the
// output compact and free of the repeated structural punctuation that triggers
// that heuristic.
const SYSTEM_PROMPT = [
  "你是一个对话分析专家。你会收到一段「人类用户提问 + AI助手最终回复」的高信号序列",
  "（已去掉中间工具调用过程），需要把这些轮次划分到若干个「任务」中。",
  "一个任务 = 用户为达成某个连续目标而进行的一组相关轮次。判断依据是语义连续性，",
  '而非字面用词；用户的简短追问（如"进展？""继续""修复"）通常属于当前任务。',
  "任务总数应控制在合理粒度（通常 5~20 个），不要过度细分。",
  "轮次是按消息 id 递增且连续的，所以每个任务只需用「起始 id」和「结束 id」表示其轮次区间",
  "（左右闭区间），无需逐个列出。任务区间按时间顺序首尾相接。",
  "你会以滚动方式处理：可能已经存在前面批次识别出的任务清单，你需要在其基础上继续——",
  "把本批轮次归入已有任务（如果本批首轮仍是上一任务的延续，就扩展那个任务的 endId），",
  "或开启新任务。",
  "",
  "严格只输出任务清单，每个任务占一行，不要任何解释、表头、代码块或多余文字。",
  "每行格式（用竖线 | 分隔，共 6 段，title/summary 内不要出现竖线和换行）：",
  "TASK|<任务序号>|<起始消息id>|<结束消息id>|<该任务轮数>|<简短任务标题>::<一句话目标>",
  "示例：",
  "TASK|1|12|46|5|修复本地数据问题::排查并重跑导致结果异常的本地数据",
  "TASK|2|47|88|7|新增选股策略::按用户要求实现并验证一条新策略",
  "你输出的必须是「截至目前的全局完整任务清单」（包含前面批次已有的所有任务）。",
].join("\n")

export class SessionTaskSegmenter {
  private llm: LlmClient
  private config: SegmenterConfig

  constructor(llm: LlmClient, config?: Partial<SegmenterConfig>) {
    this.llm = llm
    this.config = { ...DEFAULT_SEGMENTER_CONFIG, ...config }
  }

  /**
   * Segment a session into tasks. Returns an empty list when there is nothing
   * to segment (no user turns). Throws if the LLM call fails — the caller
   * decides whether to fall back to treating the session as a single task.
   */
  async segment(messages: SegmenterMessage[]): Promise<TaskSegment[]> {
    const turns = this.distill(messages)
    if (turns.length === 0) return []

    const batches = this.batchByDay(turns)
    let tasks: TaskSegment[] = []
    for (let i = 0; i < batches.length; i++) {
      tasks = await this.segmentBatch(tasks, batches[i], i + 1, batches.length)
    }
    return tasks
  }

  // ── Stage 1: distill (no LLM) ──────────────────────────────────────────────

  /**
   * Reduce a full message list to high-signal turns: each user message paired
   * with the LAST non-empty assistant reply before the next user message.
   */
  private distill(messages: SegmenterMessage[]): DistilledTurn[] {
    const turns: DistilledTurn[] = []
    let cur: { id: number; ts: string; user: string; finalReply: string } | null = null

    const flush = (): void => {
      if (!cur) return
      const day = cur.ts.slice(0, 10)
      const text = `[#${cur.id} ${cur.ts}]\nUSER: ${cur.user}\nAGENT: ${cur.finalReply || "(无文本回复)"}`
      turns.push({
        id: cur.id,
        day,
        user: cur.user,
        finalReply: cur.finalReply,
        text,
        tokens: estimateTokens(text),
      })
    }

    for (const m of messages) {
      if (m.role === "user") {
        flush()
        cur = { id: m.id, ts: m.created_at, user: norm(m.content), finalReply: "" }
      } else if (cur && m.role === "assistant") {
        const c = norm(m.content)
        if (c) cur.finalReply = c
      }
    }
    flush()
    return turns
  }

  // ── Stage 2 batching: day-aligned, capped at maxBatchTokens ─────────────────

  private batchByDay(turns: DistilledTurn[]): DistilledTurn[][] {
    const cap = this.config.maxBatchTokens
    const byDay = new Map<string, DistilledTurn[]>()
    for (const t of turns) {
      const list = byDay.get(t.day)
      if (list) list.push(t)
      else byDay.set(t.day, [t])
    }
    const days = [...byDay.keys()].sort()

    const batches: DistilledTurn[][] = []
    let cur: DistilledTurn[] = []
    let curTok = 0

    const pushCur = (): void => {
      if (cur.length) batches.push(cur)
      cur = []
      curTok = 0
    }

    for (const day of days) {
      const dayTurns = byDay.get(day)!
      const dayTok = dayTurns.reduce((a, t) => a + t.tokens, 0)

      if (curTok > 0 && curTok + dayTok > cap) pushCur()

      if (dayTok > cap) {
        // A single day alone exceeds the cap: split it internally.
        pushCur()
        let sub: DistilledTurn[] = []
        let subTok = 0
        for (const t of dayTurns) {
          if (subTok > 0 && subTok + t.tokens > cap) {
            batches.push(sub)
            sub = []
            subTok = 0
          }
          sub.push(t)
          subTok += t.tokens
        }
        if (sub.length) {
          cur = sub
          curTok = subTok
        }
      } else {
        cur.push(...dayTurns)
        curTok += dayTok
      }
    }
    pushCur()
    return batches
  }

  // ── Stage 2 call: rolling segmentation ─────────────────────────────────────

  private async segmentBatch(
    existing: TaskSegment[],
    batch: DistilledTurn[],
    batchIdx: number,
    totalBatches: number,
  ): Promise<TaskSegment[]> {
    const existingBlock = existing.length
      ? `已识别的任务清单（前面批次产生，请在此基础上继续，并原样保留这些任务）：\n${existing
          .map((t) => this.formatTaskLine(t))
          .join("\n")}`
      : "（这是第一批，暂无已识别任务）"
    const seq = batch.map((t) => t.text).join("\n\n")
    const user = [
      `这是第 ${batchIdx}/${totalBatches} 批。`,
      "",
      existingBlock,
      "",
      `本批高信号序列（${batch.length} 轮）：`,
      "",
      seq,
      "",
      "请按 TASK|... 行格式输出截至目前的全局完整任务清单。",
    ].join("\n")

    const prompt: LlmMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ]

    const raw = await this.llm.chat(prompt)
    return this.parseTasks(raw)
  }

  /** Serialise a task back to the wire line format (for the rolling block). */
  private formatTaskLine(t: TaskSegment): string {
    const title = t.title.replace(/[|\n]/g, " ").trim()
    const summary = t.summary.replace(/[|\n]/g, " ").trim()
    return `TASK|${t.index}|${t.startId}|${t.endId}|${t.turnCount}|${title}::${summary}`
  }

  /**
   * Parse the pipe-delimited "TASK|..." lines. Tolerant of code fences, stray
   * prose, and truncation: any line that does not start with TASK| or lacks a
   * valid id range is skipped. The `<title>::<summary>` tail is optional.
   */
  private parseTasks(raw: string): TaskSegment[] {
    const text = (raw || "").replace(/```/g, "")
    const tasks: TaskSegment[] = []
    let fallbackIndex = 0
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("TASK|")) continue
      const parts = trimmed.split("|")
      // TASK | index | startId | endId | turnCount | title::summary
      if (parts.length < 5) continue
      const startId = Number(parts[2])
      const endId = Number(parts[3])
      if (!Number.isFinite(startId) || !Number.isFinite(endId)) continue
      const index = Number.isFinite(Number(parts[1])) ? Number(parts[1]) : ++fallbackIndex
      const turnCount = Number.isFinite(Number(parts[4])) ? Number(parts[4]) : 0
      const tail = parts.slice(5).join("|")
      const sep = tail.indexOf("::")
      const title = (sep >= 0 ? tail.slice(0, sep) : tail).trim() || `task ${index}`
      const summary = sep >= 0 ? tail.slice(sep + 2).trim() : ""
      tasks.push({ index, title, summary, startId, endId, turnCount })
    }
    return tasks
  }
}
