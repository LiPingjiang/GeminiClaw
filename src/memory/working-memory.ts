import { existsSync, readFileSync } from "fs"
import type { MemoryPaths } from "./paths.js"

export interface WorkingMemory {
  globalFixed: string // AGENT.md（全局固定区，不可压缩）
  globalNonFixed: string // 全局 MEMORY.md + 全局当日日记（可压缩）
  agentFixed: string // agent AGENT.md（私人固定区，不可压缩）
  agentNonFixed: string // agent MEMORY.md + 当日日记（私人非固定，可压缩）
}

/** 单层记忆占用 */
export interface LayerUsage {
  chars: number
  tokens: number
}

/** 记忆占用总览（各层 + 合计 + 占上下文窗口比例） */
export interface MemoryUsage {
  globalFixed: LayerUsage
  globalNonFixed: LayerUsage
  agentFixed: LayerUsage
  agentNonFixed: LayerUsage
  totalTokens: number
  contextWindow: number
  /** totalTokens / contextWindow，0~1 */
  ratio: number
}

/** token 估算：chars / 4 × 1.2 安全系数（与 compaction 一致） */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil((text.length / 4) * 1.2)
}

function readIf(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf-8").trim() : ""
}

export class WorkingMemoryBuilder {
  constructor(private paths: MemoryPaths) {}

  build(agentId: string, date: string): WorkingMemory {
    const globalFixed = readIf(this.paths.globalAgentMd())

    const globalLtm = readIf(this.paths.globalMemoryMd())
    const globalToday = readIf(this.paths.globalDaily(date))
    const globalNonFixed = [globalLtm, globalToday].filter(Boolean).join("\n\n")

    const agentFixed = readIf(this.paths.agentAgentMd(agentId))
    const agentLtm = readIf(this.paths.agentMemoryMd(agentId))
    const agentToday = readIf(this.paths.agentDaily(agentId, date))
    const agentNonFixed = [agentLtm, agentToday].filter(Boolean).join("\n\n")

    return { globalFixed, globalNonFixed, agentFixed, agentNonFixed }
  }

  /**
   * 计算当前工作记忆的 token 占用，以及占上下文窗口的比例。
   * contextWindow 默认 200000（Claude 级别），调用方可按实际模型覆盖。
   */
  measure(agentId: string, date: string, contextWindow = 200_000): MemoryUsage {
    const wm = this.build(agentId, date)
    const layer = (s: string): LayerUsage => ({
      chars: s.length,
      tokens: estimateTokens(s),
    })
    const globalFixed = layer(wm.globalFixed)
    const globalNonFixed = layer(wm.globalNonFixed)
    const agentFixed = layer(wm.agentFixed)
    const agentNonFixed = layer(wm.agentNonFixed)
    const totalTokens =
      globalFixed.tokens +
      globalNonFixed.tokens +
      agentFixed.tokens +
      agentNonFixed.tokens
    const cw = contextWindow > 0 ? contextWindow : 200_000
    return {
      globalFixed,
      globalNonFixed,
      agentFixed,
      agentNonFixed,
      totalTokens,
      contextWindow: cw,
      ratio: totalTokens / cw,
    }
  }

  /** 渲染成人类可读的占用摘要（一行 + 各层明细），用于 /mem。 */
  renderUsageSummary(agentId: string, date: string, contextWindow = 200_000): string {
    const u = this.measure(agentId, date, contextWindow)
    const pct = (u.ratio * 100).toFixed(1)
    const fmt = (l: LayerUsage) => `${l.tokens} tok`
    return [
      `📊 记忆占用：约 ${u.totalTokens} tokens / ${u.contextWindow}（${pct}%）`,
      `  · 全局固定区：${fmt(u.globalFixed)}`,
      `  · 全局非固定区：${fmt(u.globalNonFixed)}`,
      `  · 私人固定区：${fmt(u.agentFixed)}`,
      `  · 私人非固定区：${fmt(u.agentNonFixed)}`,
    ].join("\n")
  }

  /** 渲染成可直接拼进 systemPrompt 的文本（带分区标题）。
   * globalFixed (AGENT.md) 由 buildSystemPrompt() 负责，此处不重复注入。
   */
  renderSystemPrompt(agentId: string, date: string, agentName: string): string {
    const wm = this.build(agentId, date)
    const parts: string[] = []
    // globalFixed intentionally omitted — already included via buildSystemPrompt()
    if (wm.agentFixed) {
      const header = agentName ? `## 当前助手身份（${agentName}）` : "## 当前助手身份"
      parts.push(`${header}\n${wm.agentFixed}`)
    }
    const nonFixed: string[] = []
    if (wm.globalNonFixed) nonFixed.push(`### 全局长期记忆\n${wm.globalNonFixed}`)
    if (wm.agentNonFixed) nonFixed.push(`### 本助手记忆\n${wm.agentNonFixed}`)
    if (nonFixed.length > 0) {
      parts.push(`---\n\n## 记忆\n${nonFixed.join("\n\n")}`)
    }
    return parts.join("\n\n")
  }

  /** 仅渲染全局记忆（无 agent 上下文时使用，冷启动 / 全局会话）。
   * globalFixed (AGENT.md) 由 buildSystemPrompt() 负责，此处不重复注入。
   */
  renderGlobalOnly(date: string): string {
    const globalLtm = readIf(this.paths.globalMemoryMd())
    const globalToday = readIf(this.paths.globalDaily(date))
    const globalNonFixed = [globalLtm, globalToday].filter(Boolean).join("\n\n")

    const parts: string[] = []
    // globalFixed intentionally omitted — already included via buildSystemPrompt()
    if (globalNonFixed) parts.push(`---\n\n## 记忆\n### 全局长期记忆\n${globalNonFixed}`)
    return parts.join("\n\n")
  }
}
