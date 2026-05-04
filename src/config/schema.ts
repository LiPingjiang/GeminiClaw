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
})

export const routingConfigSchema = z.object({
  default: z.string(),
  fallback: z.array(z.string()).default([]),
})

export const memoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().default(".data/sessions"),
  maxSessionAge: z.number().int().positive().default(86400),
})

export const agentConfigSchema = z.object({
  maxTurns: z.number().int().positive().default(20),
  timeoutSeconds: z.number().int().positive().default(60),
})

export const configSchema = z.object({
  server: serverConfigSchema,
  providers: z.array(providerConfigSchema).min(1),
  routing: routingConfigSchema,
  memory: memoryConfigSchema,
  agent: agentConfigSchema,
})

export type ServerConfig = z.infer<typeof serverConfigSchema>
export type ProviderConfig = z.infer<typeof providerConfigSchema>
export type RoutingConfig = z.infer<typeof routingConfigSchema>
export type MemoryConfig = z.infer<typeof memoryConfigSchema>
export type AgentConfig = z.infer<typeof agentConfigSchema>
export type Config = z.infer<typeof configSchema>
