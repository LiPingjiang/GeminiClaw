import type { Message } from "../providers/types.js"

export interface ConversationContext {
  messages: Message[]
  strategyName: string
}

export interface MemoryStrategy {
  readonly name: string
  ensureSession(sessionId: string): Promise<void>
  getContext(sessionId: string, userMessage: string, agentId?: string): Promise<ConversationContext>
  appendTurn(sessionId: string, userMsg: Message, assistantMsg: Message): Promise<void>
  appendMessages?(sessionId: string, messages: Message[]): Promise<void>
}

import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"
import os from "os"
import type { Config } from "../config/schema.js"
import type { Db } from "../db/client.js"
import type { Provider } from "../providers/types.js"
import { BufferStrategy } from "./strategies/buffer.js"
import { LayeredStrategy } from "./strategies/layered.js"

/**
 * 加载 skills 目录下所有 SKILL.md 的内容，拼接为 system prompt 片段。
 * 目录结构：skills/<name>/SKILL.md
 */
function loadSkillsPrompt(skillsDir: string): string {
  if (!existsSync(skillsDir)) return ""
  const entries = readdirSync(skillsDir)
  const parts: string[] = []
  for (const entry of entries) {
    if (entry.startsWith(".")) continue
    const entryPath = join(skillsDir, entry)
    try {
      if (!statSync(entryPath).isDirectory()) continue
    } catch {
      continue
    }
    const skillFile = join(entryPath, "SKILL.md")
    if (!existsSync(skillFile)) continue
    try {
      const content = readFileSync(skillFile, "utf-8").trim()
      // 跳过 frontmatter，只取正文
      let body = content
      if (content.startsWith("---")) {
        const endMarker = content.indexOf("---", 3)
        if (endMarker !== -1) {
          body = content.slice(endMarker + 3).trim()
        }
      }
      if (body) parts.push(body)
    } catch { /* skip unreadable */ }
  }
  if (parts.length === 0) return ""
  return "\n\n---\n\n## 可用技能\n\n" + parts.join("\n\n---\n\n")
}

export function loadSystemPrompt(): string {
  const root = join(os.homedir(), ".gemeniclaw")
  const agentMdPath = join(root, "AGENT.md")
  let base: string
  if (existsSync(agentMdPath)) {
    base = readFileSync(agentMdPath, "utf-8").trim()
  } else {
    base = "你是 GeminiClaw，一个智能 AI 助手。回答简洁、准确、有帮助。"
  }
  // 加载项目 skills 目录（cwd 下的 skills/）
  const projectSkillsDir = join(process.cwd(), "skills")
  const skillsPrompt = loadSkillsPrompt(projectSkillsDir)
  return base + skillsPrompt
}

export function buildStrategy(
  config: Config,
  db: Db,
  routerProvider: Provider | null,
): MemoryStrategy {
  if (config.memory.strategy === "layered" && routerProvider) {
    return new LayeredStrategy({
      db,
      routerProvider,
      triageProvider: routerProvider,
      systemPrompt: loadSystemPrompt(),
      recentMessageLimit: config.memory.recentMessageLimit,
      triageAfterTurns: config.memory.triageAfterTurns,
      compactThresholdBytes: config.memory.compactThresholdBytes,
      maxActiveTopics: config.memory.maxActiveTopics,
    })
  }
  return new BufferStrategy({ recentMessageLimit: config.memory.recentMessageLimit })
}
