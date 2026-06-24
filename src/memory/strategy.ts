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

import type { Config } from "../config/schema.js"
import type { Db } from "../db/client.js"
import type { Provider } from "../providers/types.js"
import { BufferStrategy } from "./strategies/buffer.js"
import { LayeredStrategy } from "./strategies/layered.js"
import { buildSystemPrompt } from "../system-prompt/builder.js"

// Re-export for callers that still use the old name (server/index.ts etc.)
export { buildSystemPrompt as loadSystemPrompt }

export function buildStrategy(
  config: Config,
  db: Db,
  routerProvider: Provider | null,
): MemoryStrategy {
  // Pass the routing model so the prompt builder can inject model-specific guidance.
  const systemPrompt = buildSystemPrompt(config.routing.default)

  if (config.memory.strategy === "layered" && routerProvider) {
    return new LayeredStrategy({
      db,
      routerProvider,
      triageProvider: routerProvider,
      systemPrompt,
      recentMessageLimit: config.memory.recentMessageLimit,
      triageAfterTurns: config.memory.triageAfterTurns,
      compactThresholdBytes: config.memory.compactThresholdBytes,
      maxActiveTopics: config.memory.maxActiveTopics,
      contextTokenBudget: config.memory.contextTokenBudget ?? 120_000,
      routingDefault: config.routing.default,
    })
  }
  return new BufferStrategy({ recentMessageLimit: config.memory.recentMessageLimit })
}
