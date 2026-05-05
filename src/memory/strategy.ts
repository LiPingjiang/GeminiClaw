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
