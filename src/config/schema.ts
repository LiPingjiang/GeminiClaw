import { z } from "zod"

export const serverConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3000),
  host: z.string().default("0.0.0.0"),
  authToken: z.string().optional(),
})

export const providerTypeSchema = z.enum(["anthropic", "openai"])

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

export const qqBotChannelSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default(""),
  clientSecret: z.string().default(""),
  webhookPath: z.string().default("/webhook/qqbot"),
})

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
  channels: z.object({
    qqbot: qqBotChannelSchema.optional(),
  }).optional(),
  workspace: workspaceConfigSchema.default({}),
  skills: skillsConfigSchema.default({}),
})

export type ServerConfig = z.infer<typeof serverConfigSchema>
export type ProviderConfig = z.infer<typeof providerConfigSchema>
export type RoutingConfig = z.infer<typeof routingConfigSchema>
export type MemoryConfig = z.infer<typeof memoryConfigSchema>
export type MemoryStrategy = z.infer<typeof memoryStrategySchema>
export type AgentConfig = z.infer<typeof agentConfigSchema>
export type QQBotChannelConfig = z.infer<typeof qqBotChannelSchema>
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>
export type SkillsDirConfig = z.infer<typeof skillsConfigSchema>
export type Config = z.infer<typeof configSchema>
