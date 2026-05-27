import { z } from "zod"

export const serverConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3000),
  host: z.string().default("0.0.0.0"),
  authToken: z.string().optional(),
})

export const providerTypeSchema = z.enum(["anthropic", "openai", "mcli", "friday"])

export const providerConfigSchema = z.object({
  name: z.string().min(1),
  type: providerTypeSchema,
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  models: z.array(z.string()).min(1),
  headers: z.record(z.string()).optional(),
})

export const routingConfigSchema = z.object({
  default: z.string(),
  fallback: z.array(z.string()).default([]),
})

export const memoryStrategySchema = z.enum(["buffer", "layered"]).default("buffer")

export const memoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().default(".data"),
  maxSessionAge: z.number().int().positive().default(86400),
  strategy: memoryStrategySchema,
  maxActiveTopics: z.number().int().min(1).max(50).default(16),
  compactThresholdBytes: z.number().int().positive().default(6144),
  recentMessageLimit: z.number().int().positive().default(20),
  triageAfterTurns: z.number().int().positive().default(3),
})

export const agentConfigSchema = z.object({
  maxTurns: z.number().int().positive().default(20),
  timeoutSeconds: z.number().int().positive().default(60),
  dispatcherModel: z.string().optional(),
})

export const qqbotConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["websocket", "webhook"]).default("websocket"),
  appId: z.string(),
  clientSecret: z.string(),
  intents: z.number().int().optional(),
  webhookPath: z.string().optional(),
})

export const channelsConfigSchema = z.object({
  qqbot: qqbotConfigSchema.optional(),
}).optional()

export const configSchema = z.object({
  server: serverConfigSchema,
  providers: z.array(providerConfigSchema).min(1),
  routing: routingConfigSchema,
  memory: memoryConfigSchema,
  agent: agentConfigSchema,
  channels: channelsConfigSchema,
})

export type ServerConfig = z.infer<typeof serverConfigSchema>
export type ProviderConfig = z.infer<typeof providerConfigSchema>
export type RoutingConfig = z.infer<typeof routingConfigSchema>
export type MemoryConfig = z.infer<typeof memoryConfigSchema>
export type MemoryStrategy = z.infer<typeof memoryStrategySchema>
export type AgentConfig = z.infer<typeof agentConfigSchema>
export type QQBotConfig = z.infer<typeof qqbotConfigSchema>
export type ChannelsConfig = z.infer<typeof channelsConfigSchema>
export type Config = z.infer<typeof configSchema>
