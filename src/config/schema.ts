import { z } from "zod"

export const serverConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3000),
  host: z.string().default("0.0.0.0"),
  authToken: z.string().optional(),
})

export const providerApiSchema = z.enum(["anth-messages", "openai-completions"])

export const providerConfigSchema = z.object({
  name: z.string().min(1),
  api: providerApiSchema,
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

export const qqbotChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["websocket", "webhook"]).default("websocket"),
  appId: z.string().min(1),
  clientSecret: z.string().min(1),
  webhookPath: z.string().optional(),
  intents: z.number().optional(),
})

/** @deprecated use qqbotChannelConfigSchema */
export const qqBotChannelSchema = qqbotChannelConfigSchema

export const channelsConfigSchema = z.object({
  qqbot: qqbotChannelConfigSchema.optional(),
}).optional()

export const agentConfigSchema = z.object({
  maxTurns: z.number().int().positive().default(20),
  timeoutSeconds: z.number().int().positive().default(60),
  systemPrompt: z.string().optional(),
})

export const workspaceConfigSchema = z.object({
  dir: z.string().default(".workspace"),
})

export const skillsConfigSchema = z.object({
  dir: z.string().default("skills"),
})

export const configSchema = z.object({
  server: serverConfigSchema,
  providers: z.array(providerConfigSchema).min(1),
  routing: routingConfigSchema,
  memory: memoryConfigSchema,
  agent: agentConfigSchema,
  channels: channelsConfigSchema,
  workspace: workspaceConfigSchema.default({}),
  skills: skillsConfigSchema.default({}),
})

export type ServerConfig = z.infer<typeof serverConfigSchema>
export type ProviderApi = z.infer<typeof providerApiSchema>
export type ProviderConfig = z.infer<typeof providerConfigSchema>
export type RoutingConfig = z.infer<typeof routingConfigSchema>
export type MemoryConfig = z.infer<typeof memoryConfigSchema>
export type MemoryStrategy = z.infer<typeof memoryStrategySchema>
export type AgentConfig = z.infer<typeof agentConfigSchema>
export type QQBotChannelConfig = z.infer<typeof qqbotChannelConfigSchema>
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>
export type SkillsDirConfig = z.infer<typeof skillsConfigSchema>
export type Config = z.infer<typeof configSchema>
