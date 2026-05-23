// src/commands/evolution.ts
// 进化仪式命令处理器 - 直接响应用户的 /进化 命令

import type { RitualHandler } from "../evolution/ritual-handler-new.js"
import type { EvolutionEngine } from "../evolution/index.js"

export class EvolutionCommandHandler {
  private ritualHandler: RitualHandler
  private evolutionEngine: EvolutionEngine

  constructor(ritualHandler: RitualHandler, evolutionEngine: EvolutionEngine) {
    this.ritualHandler = ritualHandler
    this.evolutionEngine = evolutionEngine
  }

  /**
   * 处理命令
   *
   * 支持：
   * - /进化           → 列出候选项
   * - /进化 预览 N    → 预览第N个候选项
   * - /进化 确认 N    → 应用第N个候选项
   * - /进化 拒绝 N    → 拒绝第N个候选项
   * - /进化 运行      → 手动触发进化分析
   * - /help           → 帮助信息
   * - /状态           → 系统状态
   */
  async handle(command: string, args: string[]): Promise<string> {
    try {
      switch (command) {
        case "进化":
          return this.handleEvolution(args)
        case "help":
          return this.showHelp()
        case "状态":
          return this.showStatus()
        default:
          return `❌ 未知命令: /${command}\n输入 /help 查看所有可用命令。`
      }
    } catch (error) {
      return `❌ 命令执行失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  private handleEvolution(args: string[]): Promise<string> | string {
    if (args.length === 0) {
      return this.ritualHandler.listCandidates()
    }

    const subcommand = args[0]

    switch (subcommand) {
      case "预览": {
        if (args.length < 2) return "❌ 请指定要预览的序号，如：/进化 预览 1"
        const idx = parseInt(args[1])
        if (isNaN(idx)) return "❌ 序号必须是数字"
        return this.ritualHandler.showPreview(idx)
      }

      case "确认": {
        if (args.length < 2) return "❌ 请指定要确认的序号，如：/进化 确认 1"
        const idx = parseInt(args[1])
        if (isNaN(idx)) return "❌ 序号必须是数字"
        return this.approveEvolution(idx)
      }

      case "拒绝": {
        if (args.length < 2) return "❌ 请指定要拒绝的序号，如：/进化 拒绝 1"
        const idx = parseInt(args[1])
        if (isNaN(idx)) return "❌ 序号必须是数字"
        return this.rejectEvolution(idx)
      }

      case "运行":
        return this.runEvolution()

      default:
        return `❌ 未知子命令: ${subcommand}\n输入 /help 查看所有可用命令。`
    }
  }

  // ── P0: 真正实现确认/拒绝/运行 ──────────────────────────────────────────

  private async approveEvolution(index: number): Promise<string> {
    const intentId = this.ritualHandler.getIntentIdByIndex(index)
    if (!intentId) {
      return `❌ 无效序号: ${index}，请先用 /进化 查看当前候选项`
    }
    try {
      await this.evolutionEngine.approveIntent(intentId, "user")
      // 后台触发进化周期，不阻塞响应
      this.evolutionEngine.runOnce().catch(() => undefined)
      return `✅ **第 ${index} 项已确认**\n\nEvolution Engine 正在后台处理变更，通常需要 1-3 分钟。\n使用 /状态 查看进度。`
    } catch (err) {
      return `❌ 确认失败: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  private async rejectEvolution(index: number): Promise<string> {
    const intentId = this.ritualHandler.getIntentIdByIndex(index)
    if (!intentId) {
      return `❌ 无效序号: ${index}，请先用 /进化 查看当前候选项`
    }
    try {
      await this.evolutionEngine.rejectIntent(intentId, "user rejected via command")
      return `🚫 **第 ${index} 项已拒绝**\n\n该优化项已从候选列表移除。`
    } catch (err) {
      return `❌ 拒绝失败: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  private async runEvolution(): Promise<string> {
    try {
      const count = await this.evolutionEngine.generateIntents()
      if (count === 0) {
        return "🧬 **进化分析完成**\n\n暂无新的优化建议。系统将持续监控对话记录和代码变更。"
      }
      return `🧬 **进化分析完成**\n\n新发现 ${count} 个优化候选项。\n使用 /进化 查看详情。`
    } catch (err) {
      return `❌ 进化分析失败: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // ── P1: /help 命令 ──────────────────────────────────────────────────────

  private showHelp(): string {
    return `🤖 **GeminiClaw 可用命令**

📌 **进化仪式**
  \`/进化\`              查看待优化候选项列表
  \`/进化 预览 N\`       查看第N项的详细变更预览
  \`/进化 确认 N\`       应用第N项优化
  \`/进化 拒绝 N\`       拒绝第N项优化
  \`/进化 运行\`         手动触发一次进化分析

📌 **系统**
  \`/help\`              显示此帮助信息
  \`/状态\`              查看系统运行状态

💡 **提示**：进化仪式会自动分析对话记录和代码，发现优化机会后在候选列表中展示，由你确认后才会应用。`
  }

  // ── P3: /状态 命令 ──────────────────────────────────────────────────────

  private async showStatus(): Promise<string> {
    try {
      const status = await this.evolutionEngine.getStatus()
      const lines = [
        "📊 **GeminiClaw 系统状态**\n",
        `🔄 **Evolution Engine**: ${status.enabled ? "已启用" : "已停止"}`,
        `📋 **待处理意图**: ${status.pendingIntents} 个`,
        `📈 **对话样本数**: ${status.traceCount} 条`,
        `💾 **当前 Slot**: ${status.activeSlot} / 备用: ${status.standbySlot}`,
      ]
      if (status.lastEvolution) {
        const d = new Date(status.lastEvolution.recordedAt)
        lines.push(`\n✅ **上次进化**: ${d.toLocaleString("zh-CN")}`)
      }
      if (status.lastUpstreamCheck) {
        const d = new Date(status.lastUpstreamCheck.checkedAt)
        lines.push(`🔍 **上次上游检查**: ${d.toLocaleString("zh-CN")}`)
      }
      return lines.join("\n")
    } catch (err) {
      return `❌ 获取状态失败: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
