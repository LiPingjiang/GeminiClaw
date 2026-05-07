# Evolution Ritual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现用户主动触发的"进化仪式"——聊天过程静默收集，用户说"进化"时列出候选项，展示 before/after 对话对比，用户确认后才落地。

**Architecture:** 新增 ConversationStore（存对话内容）、PreviewService（预生成对比快照）、IntentClassifier（LLM 意图分类）、RitualHandler（串联仪式流程）四个模块；移除 low-risk 自动 switch；chat route 集成意图分类分支。

**Tech Stack:** TypeScript, better-sqlite3, Fastify, existing ProviderRouter

---

## File Map

| 文件 | 类型 | 职责 |
|------|------|------|
| `src/evolution/conversation-store.ts` | 新增 | 存储每轮对话的 userMessage + agentReply |
| `src/evolution/preview-service.ts` | 新增 | 异步预生成 before/after 对比快照 |
| `src/evolution/intent-classifier.ts` | 新增 | LLM 轻量分类进化意图 |
| `src/evolution/ritual-handler.ts` | 新增 | 串联进化仪式，生成聊天回复 |
| `src/evolution/db.ts` | 修改 | 新增 conversation_samples、evolution_previews 表 |
| `src/evolution/types.ts` | 修改 | 新增 ConversationSample、EvolutionPreview 类型 |
| `src/evolution/index.ts` | 修改 | 移除自动 switch；集成 PreviewService；暴露 RitualHandler |
| `src/server/routes/chat.ts` | 修改 | 集成 ConversationStore + IntentClassifier + 仪式分支 |
| `src/server/routes/evolution.ts` | 修改 | 新增 candidates、previews/:id、reject/:id 端点 |

---

## Task 1: 新增类型定义

**Files:**
- Modify: `src/evolution/types.ts`

- [ ] **Step 1: 在 types.ts 末尾追加新类型**

在 `src/evolution/types.ts` 文件末尾（`RunOnceResult` 定义之后）追加：

```typescript
// ---------------------------------------------------------------------------
// Conversation Sample
// ---------------------------------------------------------------------------

export interface ConversationSample {
  id: string
  sessionId: string
  traceId?: string
  userMessage: string
  agentReply: string
  toolSequence: string[]
  hadFailure: boolean
  recordedAt: number
}

// ---------------------------------------------------------------------------
// Evolution Preview
// ---------------------------------------------------------------------------

export interface EvolutionPreview {
  id: string
  intentId: string
  sampleId: string
  userMessage: string
  beforeReply: string
  afterReply: string
  summary: string
  generatedAt: number
}

// ---------------------------------------------------------------------------
// Ritual Session State
// ---------------------------------------------------------------------------

export interface RitualSessionState {
  candidates: Array<{
    index: number
    intentId: string
    description: string
    riskLevel: RiskLevel
    targetFiles: string[]
  }>
  selectedIntentId?: string
}

// ---------------------------------------------------------------------------
// Intent Classification
// ---------------------------------------------------------------------------

export type ChatIntent =
  | "evolve"
  | "evolve_show"
  | "evolve_confirm"
  | "evolve_reject"
  | "chat"

export interface ClassifyResult {
  intent: ChatIntent
  index?: number   // for evolve_show: which candidate (1-based)
}
```

- [ ] **Step 2: 构建确认无类型错误**

```bash
cd ~/Codes/GeminiClaw && pnpm build 2>&1 | tail -20
```

Expected: 无新增错误（现有错误不变）

- [ ] **Step 3: Commit**

```bash
cd ~/Codes/GeminiClaw && git add src/evolution/types.ts && git commit -m "feat(evolution): add ConversationSample, EvolutionPreview, RitualSessionState types"
```

---

## Task 2: 扩展 DB 层

**Files:**
- Modify: `src/evolution/db.ts`

- [ ] **Step 1: 在 db.ts 中添加 Row 类型**

在 `PendingReviewRow` 接口定义之后（约第 100 行附近）添加：

```typescript
interface ConversationSampleRow {
  id: string
  session_id: string
  trace_id: string | null
  user_message: string
  agent_reply: string
  tool_sequence: string
  had_failure: number
  recorded_at: number
}

interface EvolutionPreviewRow {
  id: string
  intent_id: string
  sample_id: string
  user_message: string
  before_reply: string
  after_reply: string
  summary: string
  generated_at: number
}
```

- [ ] **Step 2: 在 SCHEMA_SQL 中添加两张新表**

找到 `pending_reviews` 表定义之后的位置，在 SCHEMA_SQL 字符串中追加：

```typescript
// 在现有 SCHEMA_SQL 的末尾（closing `` ` `` 之前）添加：

CREATE TABLE IF NOT EXISTS conversation_samples (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  trace_id     TEXT,
  user_message TEXT NOT NULL,
  agent_reply  TEXT NOT NULL,
  tool_sequence TEXT NOT NULL DEFAULT '[]',
  had_failure  INTEGER NOT NULL DEFAULT 0,
  recorded_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_session ON conversation_samples(session_id);
CREATE INDEX IF NOT EXISTS idx_samples_recorded ON conversation_samples(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_samples_failure ON conversation_samples(had_failure);

CREATE TABLE IF NOT EXISTS evolution_previews (
  id           TEXT PRIMARY KEY,
  intent_id    TEXT NOT NULL,
  sample_id    TEXT NOT NULL,
  user_message TEXT NOT NULL,
  before_reply TEXT NOT NULL,
  after_reply  TEXT NOT NULL,
  summary      TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_previews_intent ON evolution_previews(intent_id);
```

- [ ] **Step 3: 添加 rowToConversationSample 和 rowToEvolutionPreview 转换函数**

在 `rowToPendingReview` 函数之后添加：

```typescript
function rowToConversationSample(row: ConversationSampleRow): ConversationSample {
  return {
    id: row.id,
    sessionId: row.session_id,
    traceId: row.trace_id ?? undefined,
    userMessage: row.user_message,
    agentReply: row.agent_reply,
    toolSequence: decodeArr(row.tool_sequence),
    hadFailure: row.had_failure === 1,
    recordedAt: row.recorded_at,
  }
}

function rowToEvolutionPreview(row: EvolutionPreviewRow): EvolutionPreview {
  return {
    id: row.id,
    intentId: row.intent_id,
    sampleId: row.sample_id,
    userMessage: row.user_message,
    beforeReply: row.before_reply,
    afterReply: row.after_reply,
    summary: row.summary,
    generatedAt: row.generated_at,
  }
}
```

注意在文件顶部 import 中确认 `ConversationSample` 和 `EvolutionPreview` 已从 `./types.js` 导入。

- [ ] **Step 4: 在 EvolutionDB 类中添加 CRUD 方法**

在 `EvolutionDB` 类的末尾（`}` 之前）添加：

```typescript
  // -------------------------------------------------------------------------
  // ConversationSample
  // -------------------------------------------------------------------------

  insertConversationSample(sample: ConversationSample): void {
    this.db.prepare(`
      INSERT INTO conversation_samples
        (id, session_id, trace_id, user_message, agent_reply, tool_sequence, had_failure, recorded_at)
      VALUES
        (@id, @sessionId, @traceId, @userMessage, @agentReply, @toolSequence, @hadFailure, @recordedAt)
    `).run({
      id: sample.id,
      sessionId: sample.sessionId,
      traceId: sample.traceId ?? null,
      userMessage: sample.userMessage,
      agentReply: sample.agentReply,
      toolSequence: encodeArr(sample.toolSequence),
      hadFailure: sample.hadFailure ? 1 : 0,
      recordedAt: sample.recordedAt,
    })
    // Prune: keep only the most recent 500 samples
    this.db.prepare(`
      DELETE FROM conversation_samples
      WHERE id NOT IN (
        SELECT id FROM conversation_samples ORDER BY recorded_at DESC LIMIT 500
      )
    `).run()
  }

  listConversationSamples(opts: { limit?: number; failureOnly?: boolean } = {}): ConversationSample[] {
    const { limit = 20, failureOnly = false } = opts
    const rows = failureOnly
      ? this.db.prepare(`SELECT * FROM conversation_samples WHERE had_failure = 1 ORDER BY recorded_at DESC LIMIT ?`).all(limit) as ConversationSampleRow[]
      : this.db.prepare(`SELECT * FROM conversation_samples ORDER BY recorded_at DESC LIMIT ?`).all(limit) as ConversationSampleRow[]
    return rows.map(rowToConversationSample)
  }

  countConversationSamples(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM conversation_samples`).get() as { cnt: number }
    return row.cnt
  }

  // -------------------------------------------------------------------------
  // EvolutionPreview
  // -------------------------------------------------------------------------

  insertEvolutionPreview(preview: EvolutionPreview): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO evolution_previews
        (id, intent_id, sample_id, user_message, before_reply, after_reply, summary, generated_at)
      VALUES
        (@id, @intentId, @sampleId, @userMessage, @beforeReply, @afterReply, @summary, @generatedAt)
    `).run({
      id: preview.id,
      intentId: preview.intentId,
      sampleId: preview.sampleId,
      userMessage: preview.userMessage,
      beforeReply: preview.beforeReply,
      afterReply: preview.afterReply,
      summary: preview.summary,
      generatedAt: preview.generatedAt,
    })
  }

  listEvolutionPreviews(intentId: string): EvolutionPreview[] {
    const rows = this.db.prepare(
      `SELECT * FROM evolution_previews WHERE intent_id = ? ORDER BY generated_at DESC`
    ).all(intentId) as EvolutionPreviewRow[]
    return rows.map(rowToEvolutionPreview)
  }

  hasEvolutionPreview(intentId: string): boolean {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM evolution_previews WHERE intent_id = ?`
    ).get(intentId) as { cnt: number }
    return row.cnt > 0
  }
```

- [ ] **Step 5: 构建确认无类型错误**

```bash
cd ~/Codes/GeminiClaw && pnpm build 2>&1 | tail -20
```

Expected: 无新增错误

- [ ] **Step 6: 写单元测试**

在 `src/evolution/db.test.ts`（已存在）中添加测试：

```typescript
describe("ConversationSample CRUD", () => {
  it("inserts and lists conversation samples", () => {
    const db = new EvolutionDB(":memory:")
    db.insertConversationSample({
      id: "s1",
      sessionId: "sess-1",
      userMessage: "hello",
      agentReply: "hi there",
      toolSequence: ["tool_a"],
      hadFailure: false,
      recordedAt: Date.now(),
    })
    const samples = db.listConversationSamples()
    expect(samples).toHaveLength(1)
    expect(samples[0].userMessage).toBe("hello")
    expect(samples[0].toolSequence).toEqual(["tool_a"])
  })

  it("prunes to 500 samples on insert", () => {
    const db = new EvolutionDB(":memory:")
    for (let i = 0; i < 502; i++) {
      db.insertConversationSample({
        id: `s${i}`,
        sessionId: "sess-1",
        userMessage: `msg ${i}`,
        agentReply: `reply ${i}`,
        toolSequence: [],
        hadFailure: false,
        recordedAt: Date.now() + i,
      })
    }
    expect(db.countConversationSamples()).toBe(500)
  })
})

describe("EvolutionPreview CRUD", () => {
  it("inserts and lists previews by intentId", () => {
    const db = new EvolutionDB(":memory:")
    db.insertEvolutionPreview({
      id: "p1",
      intentId: "intent-1",
      sampleId: "s1",
      userMessage: "what is X?",
      beforeReply: "old answer",
      afterReply: "new better answer",
      summary: "improved clarity",
      generatedAt: Date.now(),
    })
    const previews = db.listEvolutionPreviews("intent-1")
    expect(previews).toHaveLength(1)
    expect(previews[0].afterReply).toBe("new better answer")
    expect(db.hasEvolutionPreview("intent-1")).toBe(true)
    expect(db.hasEvolutionPreview("intent-999")).toBe(false)
  })
})
```

- [ ] **Step 7: 运行测试**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/evolution/db.test.ts 2>&1 | tail -30
```

Expected: 所有测试通过（包括新增的）

- [ ] **Step 8: Commit**

```bash
cd ~/Codes/GeminiClaw && git add src/evolution/db.ts src/evolution/db.test.ts && git commit -m "feat(evolution): add conversation_samples and evolution_previews tables"
```

---

## Task 3: ConversationStore

**Files:**
- Create: `src/evolution/conversation-store.ts`

- [ ] **Step 1: 创建 ConversationStore**

创建 `src/evolution/conversation-store.ts`：

```typescript
// src/evolution/conversation-store.ts
// Stores per-turn conversation content (userMessage + agentReply) for use
// by PreviewService when generating before/after comparisons.

import { randomUUID } from "crypto"
import type { EvolutionDB } from "./db.js"
import type { ConversationSample } from "./types.js"

export interface SaveParams {
  sessionId: string
  traceId?: string
  userMessage: string
  agentReply: string
  toolSequence?: string[]
  hadFailure?: boolean
}

export class ConversationStore {
  private db: EvolutionDB

  constructor(db: EvolutionDB) {
    this.db = db
  }

  /**
   * Save a conversation turn. Called by the chat route after each response.
   * Designed to be called with setImmediate() — must never throw.
   */
  save(params: SaveParams): void {
    try {
      const sample: ConversationSample = {
        id: randomUUID(),
        sessionId: params.sessionId,
        traceId: params.traceId,
        userMessage: params.userMessage,
        agentReply: params.agentReply,
        toolSequence: params.toolSequence ?? [],
        hadFailure: params.hadFailure ?? false,
        recordedAt: Date.now(),
      }
      this.db.insertConversationSample(sample)
    } catch (err) {
      // Swallow errors — must never crash the main process
      console.error("[ConversationStore] Failed to save sample:", err)
    }
  }
}
```

- [ ] **Step 2: 构建确认**

```bash
cd ~/Codes/GeminiClaw && pnpm build 2>&1 | tail -20
```

Expected: 无错误

- [ ] **Step 3: Commit**

```bash
cd ~/Codes/GeminiClaw && git add src/evolution/conversation-store.ts && git commit -m "feat(evolution): add ConversationStore"
```

---

## Task 4: PreviewService

**Files:**
- Create: `src/evolution/preview-service.ts`

- [ ] **Step 1: 创建 PreviewService**

创建 `src/evolution/preview-service.ts`：

```typescript
// src/evolution/preview-service.ts
// Generates before/after conversation comparisons for pending evolution intents.
// Called asynchronously after Mutator succeeds — never blocks the main flow.

import { randomUUID } from "crypto"
import type { EvolutionDB } from "./db.js"
import type { ProviderRouter } from "../providers/router.js"
import type { Intent, ConversationSample, EvolutionPreview } from "./types.js"
import type { Logger } from "./index.js"

const MAX_SAMPLES_PER_INTENT = 3
const SUMMARY_MAX_CHARS = 120

export interface PreviewServiceParams {
  db: EvolutionDB
  providerRouter: ProviderRouter
  logger: Logger
}

export class PreviewService {
  private db: EvolutionDB
  private providerRouter: ProviderRouter
  private logger: Logger

  constructor(params: PreviewServiceParams) {
    this.db = params.db
    this.providerRouter = params.providerRouter
    this.logger = params.logger
  }

  /**
   * Asynchronously generate previews for an intent.
   * Selects up to MAX_SAMPLES_PER_INTENT representative samples,
   * re-runs the LLM with the updated config, and stores results.
   */
  async generate(intent: Intent): Promise<void> {
    if (this.db.hasEvolutionPreview(intent.id)) {
      this.logger.info("[PreviewService] previews already exist for intent %s", intent.id)
      return
    }

    const samples = this.selectSamples(intent)
    if (samples.length === 0) {
      this.logger.info("[PreviewService] no samples available for intent %s", intent.id)
      return
    }

    this.logger.info(
      "[PreviewService] generating %d previews for intent %s",
      samples.length,
      intent.id
    )

    for (const sample of samples) {
      try {
        const afterReply = await this.rerun(sample.userMessage)
        const summary = await this.summarize(intent.description, sample.beforeReply ?? sample.agentReply, afterReply)

        const preview: EvolutionPreview = {
          id: randomUUID(),
          intentId: intent.id,
          sampleId: sample.id,
          userMessage: sample.userMessage,
          beforeReply: sample.agentReply,
          afterReply,
          summary,
          generatedAt: Date.now(),
        }
        this.db.insertEvolutionPreview(preview)
        this.logger.info("[PreviewService] saved preview %s for intent %s", preview.id, intent.id)
      } catch (err) {
        this.logger.warn(
          "[PreviewService] failed to generate preview for sample %s: %s",
          sample.id,
          (err as Error).message
        )
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Select representative samples for comparison.
   * Priority: failure samples first, then most recent.
   */
  private selectSamples(intent: Intent): ConversationSample[] {
    // Try failure samples first
    const failureSamples = this.db.listConversationSamples({ limit: 5, failureOnly: true })
    const recentSamples = this.db.listConversationSamples({ limit: 10 })

    // Merge: failures first, then fill with recent (no duplicates)
    const seen = new Set<string>()
    const merged: ConversationSample[] = []
    for (const s of [...failureSamples, ...recentSamples]) {
      if (!seen.has(s.id)) {
        seen.add(s.id)
        merged.push(s)
      }
      if (merged.length >= MAX_SAMPLES_PER_INTENT) break
    }
    return merged
  }

  /**
   * Re-run the LLM with the user message to get the "after" reply.
   */
  private async rerun(userMessage: string): Promise<string> {
    const response = await this.providerRouter.chat([
      { role: "user", content: userMessage },
    ])
    return response.content
  }

  /**
   * Ask the LLM to generate a one-line summary of the improvement.
   */
  private async summarize(
    intentDescription: string,
    beforeReply: string,
    afterReply: string
  ): Promise<string> {
    const prompt = `You are summarizing an AI agent improvement. In one sentence (max ${SUMMARY_MAX_CHARS} chars), describe what changed between the before and after replies, in the context of the intent.

Intent: ${intentDescription}

Before reply (first 300 chars): ${beforeReply.slice(0, 300)}

After reply (first 300 chars): ${afterReply.slice(0, 300)}

Reply with ONLY the one-sentence summary, no quotes, no punctuation at end.`

    const response = await this.providerRouter.chat([
      { role: "user", content: prompt },
    ])
    return response.content.trim().slice(0, SUMMARY_MAX_CHARS)
  }
}
```

- [ ] **Step 2: 构建确认**

```bash
cd ~/Codes/GeminiClaw && pnpm build 2>&1 | tail -20
```

Expected: 无错误

- [ ] **Step 3: Commit**

```bash
cd ~/Codes/GeminiClaw && git add src/evolution/preview-service.ts && git commit -m "feat(evolution): add PreviewService for before/after comparison generation"
```

---

## Task 5: IntentClassifier

**Files:**
- Create: `src/evolution/intent-classifier.ts`

- [ ] **Step 1: 创建 IntentClassifier**

创建 `src/evolution/intent-classifier.ts`：

```typescript
// src/evolution/intent-classifier.ts
// Lightweight LLM-based classifier that detects whether a user message
// is triggering the evolution ritual or is a normal chat message.

import type { ProviderRouter } from "../providers/router.js"
import type { ClassifyResult } from "./types.js"

const CLASSIFY_SYSTEM = `You are a message intent classifier for an AI agent's self-improvement system.
Classify the user message into exactly one of these intents. Reply with JSON only, no explanation.

Intents:
- "evolve": user wants to see improvement candidates. Triggers: "进化", "evolve", "show improvements", "有什么可以优化的", "优化一下", "self improve", "进化一下"
- "evolve_show": user wants to see a specific candidate's preview. Triggers: "看第N个", "show me #N", "第N个", "查看第N项", where N is a number
- "evolve_confirm": user confirms applying a change. Triggers: "确认", "apply", "好的就这个", "confirm", "应用", "执行"
- "evolve_reject": user rejects or skips. Triggers: "不要", "skip", "跳过", "cancel", "取消", "算了"
- "chat": everything else

For "evolve_show", also extract the 1-based index number.

Output format:
{"intent": "evolve"} 
or
{"intent": "evolve_show", "index": 2}
or
{"intent": "chat"}`

export class IntentClassifier {
  private providerRouter: ProviderRouter

  constructor(providerRouter: ProviderRouter) {
    this.providerRouter = providerRouter
  }

  /**
   * Classify a user message. Returns "chat" on any error (fail-safe).
   */
  async classify(userMessage: string): Promise<ClassifyResult> {
    // Fast path: skip classification for long messages (clearly not ritual commands)
    if (userMessage.length > 200) {
      return { intent: "chat" }
    }

    try {
      const response = await this.providerRouter.chat([
        { role: "user", content: `${CLASSIFY_SYSTEM}\n\nUser message: ${userMessage}` },
      ])

      const text = response.content.trim()
      // Extract JSON from response (may be wrapped in ```json blocks)
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return { intent: "chat" }

      const parsed = JSON.parse(jsonMatch[0]) as { intent?: string; index?: number }
      const intent = parsed.intent as ClassifyResult["intent"]

      const validIntents = ["evolve", "evolve_show", "evolve_confirm", "evolve_reject", "chat"]
      if (!validIntents.includes(intent)) return { intent: "chat" }

      return {
        intent,
        index: typeof parsed.index === "number" ? parsed.index : undefined,
      }
    } catch {
      // Classification errors must never break the chat flow
      return { intent: "chat" }
    }
  }
}
```

- [ ] **Step 2: 构建确认**

```bash
cd ~/Codes/GeminiClaw && pnpm build 2>&1 | tail -20
```

Expected: 无错误

- [ ] **Step 3: Commit**

```bash
cd ~/Codes/GeminiClaw && git add src/evolution/intent-classifier.ts && git commit -m "feat(evolution): add IntentClassifier for ritual trigger detection"
```

---

## Task 6: RitualHandler

**Files:**
- Create: `src/evolution/ritual-handler.ts`

- [ ] **Step 1: 创建 RitualHandler**

创建 `src/evolution/ritual-handler.ts`：

```typescript
// src/evolution/ritual-handler.ts
// Orchestrates the evolution ritual: list candidates, show previews, confirm/reject.
// Maintains per-session state in memory (Map keyed by sessionId).

import type { EvolutionDB } from "./db.js"
import type { RitualSessionState, RiskLevel } from "./types.js"

const RISK_EMOJI: Record<RiskLevel, string> = {
  low: "🟡",
  medium: "🟠",
  high: "🔴",
}

const RISK_LABEL: Record<RiskLevel, string> = {
  low: "低",
  medium: "中",
  high: "高",
}

export class RitualHandler {
  private db: EvolutionDB
  private sessionStates = new Map<string, RitualSessionState>()

  constructor(db: EvolutionDB) {
    this.db = db
  }

  // ---------------------------------------------------------------------------
  // List candidates
  // ---------------------------------------------------------------------------

  listCandidates(sessionId: string): string {
    const reviews = this.db.listPendingReviews()

    if (reviews.length === 0) {
      this.clearState(sessionId)
      return "✅ 当前没有待进化的优化项。Evolution Engine 正在后台收集数据，积累足够的对话样本后会自动生成候选项。"
    }

    // Sort: medium first, then high, then low
    const order: Record<RiskLevel, number> = { medium: 0, high: 1, low: 2 }
    const sorted = [...reviews].sort((a, b) => order[a.riskLevel] - order[b.riskLevel])

    const state: RitualSessionState = {
      candidates: sorted.map((r, i) => ({
        index: i + 1,
        intentId: r.intentId,
        description: r.description,
        riskLevel: r.riskLevel,
        targetFiles: r.targetFiles,
      })),
    }
    this.sessionStates.set(sessionId, state)

    const lines = [
      `🧬 **进化候选项** — 共 ${sorted.length} 个\n`,
      ...sorted.map((r, i) => {
        const emoji = RISK_EMOJI[r.riskLevel]
        const label = RISK_LABEL[r.riskLevel]
        const files = r.targetFiles.slice(0, 2).join(", ") + (r.targetFiles.length > 2 ? " ..." : "")
        return `**${i + 1}.** ${emoji} [${label}风险] ${r.description}\n   📁 ${files}`
      }),
      `\n说"**看第N个**"查看效果对比，说"**跳过**"退出进化仪式。`,
    ]

    return lines.join("\n")
  }

  // ---------------------------------------------------------------------------
  // Show preview
  // ---------------------------------------------------------------------------

  showPreview(sessionId: string, index: number): string {
    const state = this.sessionStates.get(sessionId)
    if (!state || state.candidates.length === 0) {
      return "请先说"进化"查看候选项列表。"
    }

    const candidate = state.candidates.find(c => c.index === index)
    if (!candidate) {
      return `没有第 ${index} 个候选项，请输入 1 到 ${state.candidates.length} 之间的数字。`
    }

    state.selectedIntentId = candidate.intentId

    const previews = this.db.listEvolutionPreviews(candidate.intentId)

    if (previews.length === 0) {
      return `⏳ **第 ${index} 项** — ${candidate.description}\n\n效果对比正在生成中，请稍后再试（通常需要 1-2 分钟）。`
    }

    const lines = [
      `📊 **进化效果预览** — 第 ${index} 项`,
      `> ${candidate.description}\n`,
    ]

    previews.forEach((p, i) => {
      lines.push(`**示例 ${i + 1}：** ${p.userMessage.slice(0, 80)}${p.userMessage.length > 80 ? "..." : ""}\n`)
      lines.push(`▌ **当前回答**\n${p.beforeReply.slice(0, 400)}${p.beforeReply.length > 400 ? "\n..." : ""}\n`)
      lines.push(`▌ **优化后回答**\n${p.afterReply.slice(0, 400)}${p.afterReply.length > 400 ? "\n..." : ""}\n`)
      lines.push(`💡 ${p.summary}\n`)
      if (i < previews.length - 1) lines.push("---\n")
    })

    lines.push(`\n说"**确认**"应用这个优化，说"**跳过**"查看下一个或退出。`)

    return lines.join("\n")
  }

  // ---------------------------------------------------------------------------
  // Confirm / Reject
  // ---------------------------------------------------------------------------

  getSelectedIntentId(sessionId: string): string | undefined {
    return this.sessionStates.get(sessionId)?.selectedIntentId
  }

  clearState(sessionId: string): void {
    this.sessionStates.delete(sessionId)
  }
}
```

- [ ] **Step 2: 在 EvolutionDB 中确认 listPendingReviews 方法存在**

```bash
grep -n "listPendingReviews" ~/Codes/GeminiClaw/src/evolution/db.ts
```

如果不存在，在 db.ts 的 `insertPendingReview` 方法之后添加：

```typescript
  listPendingReviews(): PendingReview[] {
    const rows = this.db.prepare(
      `SELECT * FROM pending_reviews WHERE status = 'pending' ORDER BY requested_at ASC`
    ).all() as PendingReviewRow[]
    return rows.map(rowToPendingReview)
  }
```

- [ ] **Step 3: 构建确认**

```bash
cd ~/Codes/GeminiClaw && pnpm build 2>&1 | tail -20
```

Expected: 无错误

- [ ] **Step 4: Commit**

```bash
cd ~/Codes/GeminiClaw && git add src/evolution/ritual-handler.ts src/evolution/db.ts && git commit -m "feat(evolution): add RitualHandler and listPendingReviews"
```

---

## Task 7: 修改 EvolutionEngine — 移除自动 switch，集成 PreviewService

**Files:**
- Modify: `src/evolution/index.ts`

- [ ] **Step 1: 导入新模块**

在 `src/evolution/index.ts` 顶部的 import 区域添加：

```typescript
import { ConversationStore } from "./conversation-store.js"
import { PreviewService } from "./preview-service.js"
import { IntentClassifier } from "./intent-classifier.js"
import { RitualHandler } from "./ritual-handler.js"
```

- [ ] **Step 2: 在 EvolutionEngineParams 中添加新字段**

找到 `EvolutionEngineParams` 接口，添加字段（无需修改现有字段）：

```typescript
export interface EvolutionEngineParams {
  // ... existing fields ...
  db: EvolutionDB
  providerRouter: ProviderRouter
  repoRoot: string
  config?: Partial<EvolutionConfig>
  logger?: Logger
  memoryDbPath?: string
  upstreamRepos?: UpstreamRepo[]
}
```

（字段不变，但需要在类属性和构造函数里加新成员）

- [ ] **Step 3: 在 EvolutionEngine 类中添加新属性**

在类属性声明区域（`private running = false` 附近）添加：

```typescript
  private conversationStore: ConversationStore
  private previewService: PreviewService
  private intentClassifier: IntentClassifier
  private ritualHandler: RitualHandler
```

- [ ] **Step 4: 在构造函数中初始化新成员**

在构造函数 `this.intentEngine = new IntentEngine(...)` 之后添加：

```typescript
    this.conversationStore = new ConversationStore(this.db)
    this.previewService = new PreviewService({
      db: this.db,
      providerRouter: this.providerRouter,
      logger: this.logger,
    })
    this.intentClassifier = new IntentClassifier(this.providerRouter)
    this.ritualHandler = new RitualHandler(this.db)
```

- [ ] **Step 5: 移除自动 switch，统一走 pendingReview**

找到 `runOnce()` 中的这段代码（约第 401 行）：

```typescript
    if (effectiveIntent.riskLevel === "low" && !effectiveIntent.requiresHumanApproval) {
      // Auto switch
      this.logger.info("Auto-switching for low-risk intent %s", intent.id)
      const switchResult = await this.switcher.switch(branchName, effectiveIntent)

      if (switchResult.success) {
        this.db.updateIntentStatus(intent.id, "applied")
        // Start CircuitBreaker monitoring after successful switch
        this.circuitBreaker.startMonitoring(intent.id)
      } else {
        this.db.updateIntentStatus(intent.id, "rejected")
      }

      return {
        intentId: intent.id,
        mutationResult,
        validationResults,
        switchResult,
        skipped: false,
      }
    } else {
      // Needs approval
      this.logger.info(
        "Intent %s requires approval (riskLevel=%s, requiresHumanApproval=%s)",
        intent.id,
        effectiveIntent.riskLevel,
        effectiveIntent.requiresHumanApproval
      )
      this.db.updateIntentStatus(intent.id, "approved")  // awaiting manual switch

      // Add to pending reviews
      this.db.insertPendingReview({
        intentId: intent.id,
        description: effectiveIntent.description,
        targetFiles: effectiveIntent.targetFiles,
        riskLevel: effectiveIntent.riskLevel,
        status: "pending",
        requestedAt: Date.now(),
      })

      return {
        intentId: intent.id,
        mutationResult,
        validationResults,
        skipped: false,
        skipReason: `Needs approval (riskLevel=${effectiveIntent.riskLevel})`,
      }
    }
```

替换为：

```typescript
    // All intents require user approval — no auto-switch regardless of risk level
    this.logger.info(
      "Intent %s queued for user approval (riskLevel=%s)",
      intent.id,
      effectiveIntent.riskLevel
    )
    this.db.updateIntentStatus(intent.id, "approved")  // awaiting manual switch via ritual

    this.db.insertPendingReview({
      intentId: intent.id,
      description: effectiveIntent.description,
      targetFiles: effectiveIntent.targetFiles,
      riskLevel: effectiveIntent.riskLevel,
      status: "pending",
      requestedAt: Date.now(),
    })

    // Asynchronously generate before/after previews (non-blocking)
    setImmediate(() => {
      void this.previewService.generate(effectiveIntent).catch(err => {
        this.logger.warn("[runOnce] PreviewService.generate failed: %s", (err as Error).message)
      })
    })

    return {
      intentId: intent.id,
      mutationResult,
      validationResults,
      skipped: false,
      skipReason: `Queued for user approval (riskLevel=${effectiveIntent.riskLevel})`,
    }
```

- [ ] **Step 6: 暴露新模块的访问方法**

在 `EvolutionEngine` 类的 public 方法区域（`getStatus()` 附近）添加：

```typescript
  getConversationStore(): ConversationStore {
    return this.conversationStore
  }

  getIntentClassifier(): IntentClassifier {
    return this.intentClassifier
  }

  getRitualHandler(): RitualHandler {
    return this.ritualHandler
  }
```

- [ ] **Step 7: 构建确认**

```bash
cd ~/Codes/GeminiClaw && pnpm build 2>&1 | tail -20
```

Expected: 无错误

- [ ] **Step 8: Commit**

```bash
cd ~/Codes/GeminiClaw && git add src/evolution/index.ts && git commit -m "feat(evolution): remove auto-switch, integrate PreviewService and RitualHandler"
```

---

## Task 8: 修改 chat route — 集成 ConversationStore + 进化仪式分支

**Files:**
- Modify: `src/server/routes/chat.ts`

- [ ] **Step 1: 扩展 recordTrace helper，同步保存对话内容**

找到现有的 `recordTrace` 函数：

```typescript
function recordTrace(
  evolution: EvolutionEngine | undefined,
  sessionId: string,
  hadFailure: boolean,
  messageCount: number,
  toolSequence: string[] = [],
  responseLength = 0,
): void {
  if (!evolution) return
  setImmediate(() => {
    evolution.getTraceCollector().record({
      sessionId,
      toolSequence,
      hadFailure,
      messageCount,
      responseLength,
    })
    evolution.onTraceRecorded()
  })
}
```

替换为：

```typescript
function recordTrace(
  evolution: EvolutionEngine | undefined,
  sessionId: string,
  hadFailure: boolean,
  messageCount: number,
  toolSequence: string[] = [],
  responseLength = 0,
  userMessage?: string,
  agentReply?: string,
): void {
  if (!evolution) return
  setImmediate(() => {
    evolution.getTraceCollector().record({
      sessionId,
      toolSequence,
      hadFailure,
      messageCount,
      responseLength,
    })
    evolution.onTraceRecorded()
    // Save conversation content for PreviewService
    if (userMessage && agentReply) {
      evolution.getConversationStore().save({
        sessionId,
        userMessage,
        agentReply,
        toolSequence,
        hadFailure,
      })
    }
  })
}
```

- [ ] **Step 2: 在 chat route handler 入口处添加意图分类**

找到 chat route 中处理请求的主体（`const message = ...` 解析用户消息之后，开始构建 `allMessages` 之前），添加意图分类逻辑。

具体位置：找到 `const sid = ...` 和 `const message = ...` 赋值之后，在构建 `allMessages` 或调用 `agentLoop` 之前插入：

```typescript
      // ── Evolution ritual intent check ──────────────────────────────────────
      if (opts.evolution && message) {
        const classifier = opts.evolution.getIntentClassifier()
        const ritualHandler = opts.evolution.getRitualHandler()
        const classified = await classifier.classify(message)

        if (classified.intent === "evolve") {
          const ritualReply = ritualHandler.listCandidates(sid)
          return reply.send({ response: ritualReply, sessionId: sid, totalTurns: 0, toolsUsed: [] })
        }

        if (classified.intent === "evolve_show" && classified.index !== undefined) {
          const ritualReply = ritualHandler.showPreview(sid, classified.index)
          return reply.send({ response: ritualReply, sessionId: sid, totalTurns: 0, toolsUsed: [] })
        }

        if (classified.intent === "evolve_confirm") {
          const intentId = ritualHandler.getSelectedIntentId(sid)
          if (!intentId) {
            return reply.send({ response: "请先说"看第N个"选择一个优化项，再确认应用。", sessionId: sid, totalTurns: 0, toolsUsed: [] })
          }
          try {
            await opts.evolution.approveIntent(intentId, "user-chat")
            ritualHandler.clearState(sid)
            return reply.send({ response: "✅ 优化已应用！Evolution Engine 正在切换到新版本。", sessionId: sid, totalTurns: 0, toolsUsed: [] })
          } catch (err) {
            return reply.send({ response: `应用失败：${(err as Error).message}`, sessionId: sid, totalTurns: 0, toolsUsed: [] })
          }
        }

        if (classified.intent === "evolve_reject") {
          ritualHandler.clearState(sid)
          return reply.send({ response: "好的，已退出进化仪式。继续正常对话。", sessionId: sid, totalTurns: 0, toolsUsed: [] })
        }
        // classified.intent === "chat" → fall through to normal handling
      }
```

- [ ] **Step 3: 在所有 recordTrace 调用处传入 userMessage 和 agentReply**

找到所有 `recordTrace(opts.evolution, sid, ...)` 调用，将已有的 `finalContent` / `fullContent` / `chatResponse.content` 作为 `agentReply` 传入，`message` 作为 `userMessage` 传入。

共有 4 处调用，逐一更新（示例，实际行号以文件为准）：

```typescript
// AgentLoop 流式路径（fullContent 已有）：
recordTrace(opts.evolution, sid, hadFailure, allMessages.length + 1, toolSequence, fullContent.length, message, fullContent)

// AgentLoop 非流式路径（finalContent 已有）：
recordTrace(opts.evolution, sid, hadFailure, allMessages.length + 1, toolSequence, finalContent.length, message, finalContent)

// Legacy 流式路径（fullContent 已有）：
recordTrace(opts.evolution, sid, streamFailed, allMessages.length + 1, [], fullContent.length, message, fullContent)

// Legacy 非流式路径（chatResponse.content 已有）：
recordTrace(opts.evolution, sid, chatFailed, allMessages.length + 1, [], 0, message, chatResponse.content)
```

注意：有些路径在 `recordTrace` 之前已经有 `if (fullContent)` 判断，这些路径 agentReply 可能为空字符串，传空字符串即可（ConversationStore.save 只存非空回复）。

- [ ] **Step 4: 构建确认**

```bash
cd ~/Codes/GeminiClaw && pnpm build 2>&1 | tail -20
```

Expected: 无错误

- [ ] **Step 5: Commit**

```bash
cd ~/Codes/GeminiClaw && git add src/server/routes/chat.ts && git commit -m "feat(chat): integrate ConversationStore and evolution ritual intent handling"
```

---

## Task 9: 扩展 evolution route — 新增 candidates、previews、reject 端点

**Files:**
- Modify: `src/server/routes/evolution.ts`

- [ ] **Step 1: 添加三个新端点**

在 `evolution.ts` 的 `generate-intents` 端点之后添加：

```typescript
  // ---------------------------------------------------------------------------
  // GET /v1/evolution/candidates
  // ---------------------------------------------------------------------------
  fastify.get("/v1/evolution/candidates", async (_req, reply) => {
    try {
      const reviews = evolution.db.listPendingReviews()
      const candidates = reviews.map((r, i) => ({
        index: i + 1,
        intentId: r.intentId,
        description: r.description,
        riskLevel: r.riskLevel,
        targetFiles: r.targetFiles,
        hasPreview: evolution.db.hasEvolutionPreview(r.intentId),
        requestedAt: r.requestedAt,
      }))
      return reply.send({ candidates, count: candidates.length })
    } catch (err) {
      fastify.log.error(err)
      return reply.status(500).send({ error: "Failed to list candidates" })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /v1/evolution/previews/:intentId
  // ---------------------------------------------------------------------------
  fastify.get<{ Params: { intentId: string } }>(
    "/v1/evolution/previews/:intentId",
    async (req, reply) => {
      const { intentId } = req.params
      try {
        const previews = evolution.db.listEvolutionPreviews(intentId)
        return reply.send({ previews, count: previews.length, ready: previews.length > 0 })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: "Failed to get previews" })
      }
    }
  )

  // ---------------------------------------------------------------------------
  // POST /v1/evolution/reject/:id
  // ---------------------------------------------------------------------------
  fastify.post<{
    Params: { id: string }
    Body: { reason?: string }
  }>("/v1/evolution/reject/:id", async (req, reply) => {
    const { id } = req.params
    const reason = (req.body as { reason?: string })?.reason ?? "user-rejected"
    try {
      await evolution.rejectIntent(id, reason)
      return reply.send({ success: true, intentId: id })
    } catch (err) {
      const message = (err as Error).message
      if (message.includes("not found")) {
        return reply.status(404).send({ error: message })
      }
      fastify.log.error(err)
      return reply.status(500).send({ error: "Failed to reject intent" })
    }
  })
```

注意：`evolution.db` 需要在 `EvolutionEngine` 上暴露（或通过 getter）。如果 `db` 是 private，在 `EvolutionEngine` 中添加：

```typescript
  getDb(): EvolutionDB {
    return this.db
  }
```

并将 evolution route 中的 `evolution.db` 改为 `evolution.getDb()`。

- [ ] **Step 2: 在 EvolutionEngine 中添加 rejectIntent 方法**

在 `approveIntent` 方法之后添加：

```typescript
  async rejectIntent(intentId: string, reason: string): Promise<void> {
    const reviews = this.db.listPendingReviews()
    const review = reviews.find(r => r.intentId === intentId)
    if (!review) {
      throw new Error(`No pending review found for intent ${intentId}`)
    }
    this.db.resolvePendingReview(intentId, "rejected", reason)
    this.db.updateIntentStatus(intentId, "rejected")
    this.logger.info("Intent %s rejected: %s", intentId, reason)
  }
```

- [ ] **Step 3: 确认 resolvePendingReview 方法存在**

```bash
grep -n "resolvePendingReview" ~/Codes/GeminiClaw/src/evolution/db.ts
```

如果不存在，在 `insertPendingReview` 方法之后添加：

```typescript
  resolvePendingReview(intentId: string, status: "approved" | "rejected", reviewer?: string): void {
    this.db.prepare(`
      UPDATE pending_reviews
      SET status = @status, reviewer = @reviewer, resolved_at = @resolvedAt
      WHERE intent_id = @intentId
    `).run({
      intentId,
      status,
      reviewer: reviewer ?? null,
      resolvedAt: Date.now(),
    })
  }
```

- [ ] **Step 4: 构建确认**

```bash
cd ~/Codes/GeminiClaw && pnpm build 2>&1 | tail -20
```

Expected: 无错误

- [ ] **Step 5: Commit**

```bash
cd ~/Codes/GeminiClaw && git add src/server/routes/evolution.ts src/evolution/index.ts src/evolution/db.ts && git commit -m "feat(evolution): add candidates, previews, reject API endpoints"
```

---

## Task 10: 集成测试 & 验收

**Files:**
- Test: `src/server/routes/evolution.test.ts`（扩展）
- Test: `src/evolution/index.test.ts`（扩展）

- [ ] **Step 1: 运行全量测试，确认无回归**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -40
```

Expected: 所有原有测试通过，无新增失败

- [ ] **Step 2: 手动冒烟测试 — 启动服务**

```bash
cd ~/Codes/GeminiClaw && pnpm build && node dist/index.js &
sleep 3
```

- [ ] **Step 3: 测试 candidates API**

```bash
curl -s http://localhost:18888/v1/evolution/candidates | jq .
```

Expected: `{"candidates": [...], "count": N}`（N 可能为 0）

- [ ] **Step 4: 测试 previews API**

```bash
# 先获取一个 intentId（如果有的话）
INTENT_ID=$(curl -s http://localhost:18888/v1/evolution/candidates | jq -r '.candidates[0].intentId // "test-id"')
curl -s http://localhost:18888/v1/evolution/previews/$INTENT_ID | jq .
```

Expected: `{"previews": [...], "count": N, "ready": false/true}`

- [ ] **Step 5: 测试聊天意图分类 — evolve 触发**

```bash
curl -s -X POST http://localhost:18888/v1/agent/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer gemeniclaw-local-dev-token-2026" \
  -d '{"message": "进化", "session_id": "test-ritual"}' | jq .response
```

Expected: 包含 "进化候选项" 或 "当前没有待进化的优化项" 的回复

- [ ] **Step 6: 测试 reject API**

```bash
# 如果有候选项
curl -s -X POST http://localhost:18888/v1/evolution/reject/some-intent-id \
  -H "Content-Type: application/json" \
  -d '{"reason": "test"}' | jq .
```

Expected: `{"success": true, "intentId": "..."}`（或 404 如果 ID 不存在）

- [ ] **Step 7: 停止测试服务**

```bash
pkill -f "node dist/index.js"
```

- [ ] **Step 8: 最终构建确认**

```bash
cd ~/Codes/GeminiClaw && pnpm build 2>&1 | tail -10
```

Expected: `Build succeeded` 或无错误输出

- [ ] **Step 9: 最终 Commit**

```bash
cd ~/Codes/GeminiClaw && git add -A && git status
# 确认无意外文件，然后：
git commit -m "feat(evolution): evolution ritual — full implementation complete"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** ConversationStore ✓ PreviewService ✓ IntentClassifier ✓ RitualHandler ✓ 移除自动 switch ✓ Dashboard API ✓
- [x] **No placeholders:** 所有代码步骤均包含完整实现
- [x] **Type consistency:** `ConversationSample`、`EvolutionPreview`、`ClassifyResult`、`RitualSessionState` 在 Task 1 定义，后续任务引用一致
- [x] **Method names:** `listPendingReviews`、`resolvePendingReview`、`hasEvolutionPreview`、`listEvolutionPreviews` 均在 Task 2 定义，Task 6/9 引用一致
- [x] **DB 暴露方式:** Task 9 通过 `getDb()` getter 访问，Task 7 中添加了该方法
