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

import { existsSync, readFileSync } from "fs"
import { join } from "path"
import os from "os"
import type { Config } from "../config/schema.js"
import type { Db } from "../db/client.js"
import type { Provider } from "../providers/types.js"
import { BufferStrategy } from "./strategies/buffer.js"
import { LayeredStrategy } from "./strategies/layered.js"

function loadSystemPrompt(): string {
  const agentMdPath = join(os.homedir(), ".gemeniclaw", "AGENT.md")
  if (existsSync(agentMdPath)) {
    return readFileSync(agentMdPath, "utf-8").trim()
  }
  return "你是 GeminiClaw，一个智能 AI 助手。回答简洁、准确、有帮助。"
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
