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
      return '请先说“进化”查看候选项列表。'
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
  // Confirm / Reject helpers
  // ---------------------------------------------------------------------------

  getSelectedIntentId(sessionId: string): string | undefined {
    return this.sessionStates.get(sessionId)?.selectedIntentId
  }

  clearState(sessionId: string): void {
    this.sessionStates.delete(sessionId)
  }
}
