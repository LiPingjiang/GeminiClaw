// src/evolution/ritual-handler-new.ts
// 简化的进化仪式处理器，移除 IntentClassifier，直接响应用户命令

import type { EvolutionDB } from "./db.js"
import type { RiskLevel } from "./types.js"

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

  constructor(db: EvolutionDB) {
    this.db = db
  }

  // ---------------------------------------------------------------------------
  // 列出所有候选项
  // ---------------------------------------------------------------------------
  listCandidates(): string {
    const reviews = this.db.listPendingReviews()

    if (reviews.length === 0) {
      return "✅ 当前没有待进化的优化项。Evolution Engine 正在后台收集数据，积累足够的对话样本后会自动生成候选项。"
    }

    // 按风险等级排序：medium → high → low
    const order: Record<RiskLevel, number> = { medium: 0, high: 1, low: 2 }
    const sorted = [...reviews].sort((a, b) => order[a.riskLevel] - order[b.riskLevel])

    const lines = [
      `🧬 **进化候选项** — 共 ${sorted.length} 个\n`,
      ...sorted.map((r, i) => {
        const emoji = RISK_EMOJI[r.riskLevel]
        const label = RISK_LABEL[r.riskLevel]
        const files = r.targetFiles.slice(0, 2).join(", ") + (r.targetFiles.length > 2 ? " ..." : "")
        return `**${i + 1}.** ${emoji} [${label}风险] ${r.description}\n   📁 ${files}`
      }),
      `\n使用以下命令操作：\n• "/进化 预览 N" - 查看第N个效果对比\n• "/进化 确认 N" - 应用第N个优化\n• "/进化 拒绝 N" - 拒绝第N个优化`,
    ]

    return lines.join("\n")
  }

  // ---------------------------------------------------------------------------
  // 预览指定候选项
  // ---------------------------------------------------------------------------
  showPreview(index: number): string {
    const reviews = this.db.listPendingReviews()
    
    if (index < 1 || index > reviews.length) {
      return `无效序号，请输入 1 到 ${reviews.length} 之间的数字。`
    }

    const target = reviews[index - 1]
    const previews = this.db.listEvolutionPreviews(target.intentId)

    if (previews.length === 0) {
      return `⏳ **第 ${index} 项** — ${target.description}\n\n效果对比正在生成中，请稍后再试（通常需要 1-2 分钟）。`
    }

    const lines = [
      `📊 **进化效果预览** — 第 ${index} 项`,
      `> ${target.description}\n`,
    ]

    previews.forEach((p, i) => {
      lines.push(`**示例 ${i + 1}：** ${p.userMessage.slice(0, 80)}${p.userMessage.length > 80 ? "..." : ""}\n`)
      lines.push(`▌ **当前回答**\n${p.beforeReply.slice(0, 400)}${p.beforeReply.length > 400 ? "\n..." : ""}\n`)
      lines.push(`▌ **优化后回答**\n${p.afterReply.slice(0, 400)}${p.afterReply.length > 400 ? "\n..." : ""}\n`)
      lines.push(`💡 ${p.summary}\n`)
      if (i < previews.length - 1) lines.push("---\n")
    })

    lines.push(`\n使用 "/进化 确认 ${index}" 或 "/进化 拒绝 ${index}" 进行操作。`)

    return lines.join("\n")
  }

  // ---------------------------------------------------------------------------
  // 获取候选项的 intentId
  // ---------------------------------------------------------------------------
  getIntentIdByIndex(index: number): string | null {
    const reviews = this.db.listPendingReviews()
    if (index < 1 || index > reviews.length) {
      return null
    }
    return reviews[index - 1].intentId
  }
}