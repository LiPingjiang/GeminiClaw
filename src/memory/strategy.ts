import type { Message } from "../providers/types.js"

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

const DEFAULT_SYSTEM_PROMPT = `你是 GeminiClaw，一个智能 AI 助手。回答简洁、准确、有帮助。`

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
      systemPrompt: config.agent.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      recentMessageLimit: config.memory.recentMessageLimit,
      triageAfterTurns: config.memory.triageAfterTurns,
      compactThresholdBytes: config.memory.compactThresholdBytes,
      maxActiveTopics: config.memory.maxActiveTopics,
    })
  }
  return new BufferStrategy({ recentMessageLimit: config.memory.recentMessageLimit })
}
