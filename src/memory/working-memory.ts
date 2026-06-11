import { existsSync, readFileSync } from "fs"
import type { MemoryPaths } from "./paths.js"

export interface WorkingMemory {
  globalFixed: string // AGENT.md（全局固定区，不可压缩）
  globalNonFixed: string // 全局 MEMORY.md + 全局当日日记（可压缩）
  agentFixed: string // agent AGENT.md（私人固定区，不可压缩）
  agentNonFixed: string // agent MEMORY.md + 当日日记（私人非固定，可压缩）
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

  /** 渲染成可直接拼进 systemPrompt 的文本（带分区标题）。 */
  renderSystemPrompt(agentId: string, date: string, agentName: string): string {
    const wm = this.build(agentId, date)
    const parts: string[] = []
    if (wm.globalFixed) parts.push(wm.globalFixed)
    if (wm.agentFixed) {
      parts.push(`## 当前助手身份（${agentName}）\n${wm.agentFixed}`)
    }
    const nonFixed: string[] = []
    if (wm.globalNonFixed) nonFixed.push(`### 全局长期记忆\n${wm.globalNonFixed}`)
    if (wm.agentNonFixed) nonFixed.push(`### 本助手记忆\n${wm.agentNonFixed}`)
    if (nonFixed.length > 0) {
      parts.push(`---\n\n## 记忆\n${nonFixed.join("\n\n")}`)
    }
    return parts.join("\n\n")
  }
}
