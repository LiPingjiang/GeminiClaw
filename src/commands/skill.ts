// src/commands/skill.ts
// 技能管理命令处理器

import { join } from "path"
import { SkillLoader } from "../skills/loader-full.js"

export class SkillCommandHandler {
  private skillsDir: string

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir ?? join(process.cwd(), "skills")
  }

  /**
   * 处理 /技能 命令
   *
   * 支持子命令：
   * - /技能 列表          → 列出所有已加载技能
   * - /技能 详情 <名称>   → 查看技能详情
   */
  async handle(command: string, args: string[]): Promise<string> {
    try {
      if (command !== "技能") {
        return `未知命令: /${command}`
      }
      return this.handleSkill(args)
    } catch (error) {
      return `❌ 命令执行失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  private handleSkill(args: string[]): string {
    const subcommand = args[0] ?? "列表"

    switch (subcommand) {
      case "列表":
        return this.listSkills()
      case "详情":
        if (args.length < 2) return "❌ 请指定技能名称，如：/技能 详情 my_skill"
        return this.showSkillDetail(args[1])
      default:
        return `❌ 未知子命令: ${subcommand}\n可用命令：/技能 列表、/技能 详情 <名称>`
    }
  }

  private listSkills(): string {
    const skills = SkillLoader.loadSkills(this.skillsDir)

    if (skills.length === 0) {
      return `📦 当前没有已加载的技能。\n\n技能文件应放置在 ${this.skillsDir} 目录下，文件名以 _SKILL.md 结尾。`
    }

    const lines = [`📦 **已加载技能** — 共 ${skills.length} 个\n`]
    skills.forEach((skill, i) => {
      const desc = skill.description ? ` — ${skill.description}` : ""
      lines.push(`**${i + 1}.** ${skill.name}${desc}`)
    })
    lines.push("\n使用 \"/技能 详情 <名称>\" 查看技能详情")

    return lines.join("\n")
  }

  private showSkillDetail(name: string): string {
    const skills = SkillLoader.loadSkills(this.skillsDir)
    const skill = skills.find(
      s => s.name.toLowerCase() === name.toLowerCase() || s.name === name
    )

    if (!skill) {
      const names = skills.map(s => s.name).join(", ")
      return `❌ 未找到技能: ${name}\n\n可用技能: ${names || "（无）"}`
    }

    const lines = [
      `📄 **技能详情：${skill.name}**\n`,
      `**描述：** ${skill.description || "（无描述）"}`,
      `**文件：** ${skill.filePath}`,
    ]

    if (skill.content.trim()) {
      const preview = skill.content.slice(0, 800)
      lines.push(`\n**内容预览：**\n${preview}${skill.content.length > 800 ? "\n..." : ""}`)
    }

    return lines.join("\n")
  }
}
