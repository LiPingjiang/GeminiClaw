import type { Message } from "../providers/types.js"
import { readFileSync, existsSync } from "fs"
import { join } from "path"

export interface ConversationContext {
  /** 注入给主模型的消息列表（含 system、历史、当前消息前的所有内容） */
  messages: Message[]
  /** 调试/日志用：使用了哪个策略 */
  strategyName: string
}

export interface MemoryStrategy {
  readonly name: string
  /** 确保 session 存在（幂等） */
  ensureSession(sessionId: string): Promise<void>
  /** 根据当前用户消息，组装注入主模型的 context */
  getContext(sessionId: string, userMessage: string): Promise<ConversationContext>
  /** 主模型回复后，追加本轮对话并触发后台异步处理 */
  appendTurn(sessionId: string, userMsg: Message, assistantMsg: Message): Promise<void>
}

import type { Config } from "../config/schema.js"
import type { Db } from "../db/client.js"
import type { Provider } from "../providers/types.js"
import { BufferStrategy } from "./strategies/buffer.js"
import { LayeredStrategy } from "./strategies/layered.js"
import { SqliteStrategy } from "./strategies/sqlite.js"

function loadSystemPrompt(): string {
  // 优先加载项目根目录的 AGENT.md
  const agentMdPath = join(process.cwd(), 'AGENT.md')
  if (existsSync(agentMdPath)) {
    console.log(`[memory] Loaded system prompt from ${agentMdPath}`)
    return readFileSync(agentMdPath, 'utf-8').trim()
  }
  console.warn('[memory] AGENT.md not found, using default system prompt')
  return DEFAULT_SYSTEM_PROMPT_FALLBACK
}

const DEFAULT_SYSTEM_PROMPT_FALLBACK = `你是 GeminiClaw，一个独立的 AI Agent 运行时，由李平江开发。

## 关于你的记忆

你的记忆存储在 SQLite 数据库中（/tmp/geminiclaw-test/geminiclaw.db），通过内置的 LayeredMemory 系统管理。
你的记忆包括：对话历史（chat_messages 表）、话题索引（memory_topics 表）。
当前对话的上下文会自动注入到你的 context 中，你无需主动查询数据库。

## 重要边界约束

- 你的工作目录是 /Users/lipingjiang/Codes/GeminiClaw
- 不要读取 ~/.claude/、~/claude-obsidian/、~/.openclaw/ 等其他 AI 工具的配置文件——那些不是你的记忆
- 不要用 exec 工具在文件系统中搜索记忆，不要读取与 GeminiClaw 无关的目录

## 回答风格
简洁、准确、直接。`

export function buildStrategy(
  config: Config,
  db: Db,
  routerProvider: Provider | null,
): MemoryStrategy {
  if (config.memory.strategy === "sqlite") {
    return new SqliteStrategy(db, config.memory.recentMessageLimit)
  }
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
