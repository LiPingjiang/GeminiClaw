import { z } from "zod"

export const serverConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3000),
  host: z.string().default("0.0.0.0"),
  authToken: z.string().optional(),
})

export const providerTypeSchema = z.enum(["anthropic", "openai", "mcli", "friday", "llm-gw"])

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

/**
 * Skill-evolution (Hermes-style) engine config. Independent from the code
 * engine — can be toggled on its own.
 */
export const skillEvolutionConfigSchema = z.object({
  /** Master switch for the skill engine. */
  enabled: z.boolean().default(false),
  /** Root dir for skill files. Defaults to ~/.geminiclaw/skills if omitted. */
  skillsRoot: z.string().optional(),
  /** Scheduler: idle threshold (ms). */
  idleThresholdMs: z.number().int().positive().default(5 * 60 * 1000),
  /** Scheduler: cron interval (ms). 0 disables cron. */
  cronIntervalMs: z.number().int().min(0).default(30 * 60 * 1000),
  /** Scheduler: cooldown between triggers (ms). */
  cooldownMs: z.number().int().positive().default(10 * 60 * 1000),
  /** Max create/refine actions per cycle. */
  maxActionsPerCycle: z.number().int().min(1).max(10).default(2),
  /** Default lookback window (ms) for automatic conversation scans. */
  lookbackMs: z.number().int().positive().default(24 * 60 * 60 * 1000),
  /** Max candidate conversations turned into reflections per scan. */
  maxCandidates: z.number().int().min(1).default(3),
}).default({})

/** Code-evolution (twin-system) engine switch. */
export const codeEvolutionToggleSchema = z.object({
  /**
   * Master switch for the code engine. If omitted, falls back to the legacy
   * top-level `evolution.enabled` for backward compatibility.
   */
  enabled: z.boolean().optional(),
}).default({})

export const evolutionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Per-engine toggles (dual-engine architecture). */
  code: codeEvolutionToggleSchema,
  skill: skillEvolutionConfigSchema,
  dataDir: z.string().default(".gemini-data"),
  /** Scheduler: idle detection threshold (ms) */
  idleThresholdMs: z.number().int().positive().default(5 * 60 * 1000),
  /** Scheduler: cron interval (ms). 0 to disable cron triggers. */
  cronIntervalMs: z.number().int().min(0).default(30 * 60 * 1000),
  /** Scheduler: minimum cooldown between triggers (ms) */
  cooldownMs: z.number().int().positive().default(10 * 60 * 1000),
  /** Mutator: max LLM rounds per mutation */
  maxMutationRounds: z.number().int().min(1).max(10).default(3),
  /** Mutator: confidence threshold to auto-proceed */
  confidenceThreshold: z.number().min(0).max(1).default(0.7),
  /** Validator: test port for Level 2 temporary process */
  testPort: z.number().int().min(1024).max(65535).default(19889),
  /** Monitor: post-switch monitoring window (ms) */
  postSwitchMonitorMs: z.number().int().positive().default(5 * 60 * 1000),
  /** Monitor: failure rate threshold to trigger rollback */
  failureRateThreshold: z.number().min(0).max(1).default(0.1),
  /** Safety: paths protected from auto-evolution */
  protectedPaths: z.array(z.string()).default([
    "src/config/",
    "src/twin-system/",
    ".gemini-data/",
  ]),
  /** Safety: max evolutions per file in 24 hours */
  maxEvolutionsPerFile24h: z.number().int().min(1).default(3),
  /** Pipeline: auto-switch after validation (vs require manual approval) */
  autoSwitch: z.boolean().default(false),
  /** Git: main branch name */
  mainBranch: z.string().default("main"),
  /** Budget: max evolution cycles per calendar day. 0 = unlimited. */
  maxCyclesPerDay: z.number().int().min(0).default(0),
  /** Dry-run mode: run mutation + validation but skip actual slot switch */
  dryRun: z.boolean().default(false),
  /** Auto-approval: risk levels that bypass human review */
  autoApproveRiskLevels: z.array(z.enum(["low", "medium", "high"])).default(["low"]),
  /** Approval timeout (ms): pending requests auto-reject after this */
  approvalTimeoutMs: z.number().int().positive().default(60 * 60 * 1000),
}).default({})

export const configSchema = z.object({
  server: serverConfigSchema,
  providers: z.array(providerConfigSchema).min(1),
  routing: routingConfigSchema,
  memory: memoryConfigSchema,
  agent: agentConfigSchema,
  channels: channelsConfigSchema,
  evolution: evolutionConfigSchema,
})

export type ServerConfig = z.infer<typeof serverConfigSchema>
export type ProviderConfig = z.infer<typeof providerConfigSchema>
export type RoutingConfig = z.infer<typeof routingConfigSchema>
export type MemoryConfig = z.infer<typeof memoryConfigSchema>
export type MemoryStrategy = z.infer<typeof memoryStrategySchema>
export type AgentConfig = z.infer<typeof agentConfigSchema>
export type QQBotConfig = z.infer<typeof qqbotConfigSchema>
export type ChannelsConfig = z.infer<typeof channelsConfigSchema>
export type EvolutionConfig = z.infer<typeof evolutionConfigSchema>
export type Config = z.infer<typeof configSchema>
