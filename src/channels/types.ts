// src/channels/types.ts
// IChannel interface and ChannelContext definition.
import type { ProviderRouter } from "../providers/router.js";
import type { MemoryStrategy } from "../memory/strategy.js";
import type { AgentLoop } from "../agent/index.js";
import type { Config } from "../config/schema.js";
import type { EvolutionEngine } from "../evolution/index.js";

export interface ChannelContext {
  router: ProviderRouter;
  memory: MemoryStrategy;
  agentLoop: AgentLoop;
  config: Config;
  evolution?: EvolutionEngine;
}

export interface IChannel {
  readonly name: string;
  start(ctx: ChannelContext): Promise<void>;
  stop(): Promise<void>;
}
