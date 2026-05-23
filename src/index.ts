// src/index.ts
import { loadConfig } from "./config/loader.js"
import { UniversalProvider } from "./providers/universal.js"
import { ProviderRouter } from "./providers/router.js"
import { buildStrategy } from "./memory/strategy.js"
import { buildServer } from "./server/index.js"
import { openDb } from "./db/client.js"
import { migrate } from "./db/schema.js"
import { join } from "path"
import { mkdirSync } from "fs"
import { EvolutionEngine, EvolutionDB } from "./evolution/index.js"
import { agentPool } from "./mesh/index.js"
import type { Provider } from "./providers/types.js"
import type { ProviderConfig } from "./config/schema.js"

function buildProvider(config: ProviderConfig): Provider {
  return new UniversalProvider(config)
}

async function main(): Promise<void> {
  const config = loadConfig()

  // Provider 初始化
  const providers = config.providers.map(buildProvider)
  const router = new ProviderRouter(providers, config.routing)

  // DB 初始化（layered 策略需要）
  const dbPath = join(config.memory.dataDir, "geminiclaw.db")
  const db = openDb(dbPath)
  migrate(db)

  // 用于 layered 记忆策略的摘要/路由 provider，使用默认路由对应的 provider
  const defaultProviderName = config.routing.default.split("/")[0]
  const routerProvider = providers.find(p => p.name === defaultProviderName) ?? providers[0] ?? null

  // 记忆策略
  const strategy = buildStrategy(config, db, routerProvider)

  // Evolution Engine 初始化
  const evolutionDataDir = join(config.memory.dataDir, "evolution")
  mkdirSync(evolutionDataDir, { recursive: true })
  const evolutionDb = new EvolutionDB(join(evolutionDataDir, "gemini-evolution.db"))
  const evolution = new EvolutionEngine({
    db: evolutionDb,
    providerRouter: router,
    repoRoot: process.cwd(),
    memoryDbPath: dbPath,
  })
  await evolution.start()

  // 初始化 SkillSystem
  const { SkillSystem } = await import("./skills/index.js")
  const skillsDir = join(process.cwd(), "skills")
  mkdirSync(skillsDir, { recursive: true })
  const skillSystem = new SkillSystem(skillsDir)
  skillSystem.initialize(evolutionDb)

  // 设置全局 EvolutionEngine 引用
  const { setEvolutionEngine } = await import("./server/routes/evolution-deps.js")
  setEvolutionEngine(evolution)

  const server = await buildServer(config, router, strategy, evolution)

  await server.listen({ port: config.server.port, host: config.server.host })
  console.log(`GeminiClaw listening on ${config.server.host}:${config.server.port}`)
  console.log(`Memory strategy: ${strategy.name}`)

  // Initialize AgentPool (always-on misc agents)
  await agentPool.initialize()
}

main().catch(err => {
  console.error("Fatal error:", err)
  process.exit(1)
})
