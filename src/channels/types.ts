// src/channels/types.ts
// IChannel interface and ChannelContext definition.

import type { ProviderRouter } from "../providers/router.js"
import type { MemoryStrategy } from "../memory/strategy.js"

export interface ChannelContext {
  router: ProviderRouter
  memory: MemoryStrategy
}

export interface IChannel {
  readonly name: string
  start(ctx: ChannelContext): Promise<void>
  stop(): Promise<void>
}
