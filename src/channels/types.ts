// src/channels/types.ts
// IChannel interface and ChannelContext definition.

import type { ProviderRouter } from "../providers/router.js"
import type { MemoryStrategy } from "../memory/strategy.js"
import type { AgentLoop } from "../agent/index.js"

export interface ChannelContext {
  router: ProviderRouter       // 保留（部分场景仍需直接 chat）
  memory: MemoryStrategy
  agentLoop: AgentLoop         // 新增：支持 tool calls
}

export interface IChannel {
  readonly name: string
  start(ctx: ChannelContext): Promise<void>
  stop(): Promise<void>
}
