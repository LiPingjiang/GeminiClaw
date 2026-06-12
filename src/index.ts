// src/index.ts
import { loadConfig } from "./config/loader.js"
import { AnthropicProvider } from "./providers/anthropic.js"
import { McliProvider } from "./providers/mcli.js"
import { LlmGwProvider } from "./providers/llm-gw.js"
import { FridayProvider } from "./providers/friday.js"
import { ProviderRouter } from "./providers/router.js"
import { buildStrategy } from "./memory/strategy.js"
import { buildServer } from "./server/index.js"
import { openDb } from "./db/client.js"
import { migrate } from "./db/schema.js"
import { createEvolutionSystem } from "./evolution-core/orchestrator.js"
import { join } from "path"
import type { Provider } from "./providers/types.js"
import type { ProviderConfig } from "./config/schema.js"

function buildProvider(config: ProviderConfig): Provider {
  switch (config.type) {
    case "anthropic":
      return new AnthropicProvider(config)
    case "mcli":
      return new McliProvider(config)
    case "llm-gw":
      return new LlmGwProvider(config)
    case "friday":
      return new FridayProvider(config)
    default:
      throw new Error(`Unsupported provider type: ${config.type}`)
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  const providers = config.providers.map(buildProvider)
  const router = new ProviderRouter(providers, config.routing)
  const dbPath = join(config.memory.dataDir, "geminiclaw.db")
  const db = openDb(dbPath)
  migrate(db)
  // 用 routing.default 指定的 provider 做 triage/routing，不依赖固定名称
  const defaultProviderName = config.routing.default.split("/")[0]
  const routerProvider = providers.find(p => p.name === defaultProviderName) ?? providers[0] ?? null
  const strategy = buildStrategy(config, db, routerProvider)
  // ── Evolution system (dual engine: code + skill, each toggled separately) ──
  const evolution = createEvolutionSystem(
    config,
    router,
    db,
    config.server.port,
  )
  const twinSystem = evolution.twin

  // Expose globally for tool commands (e.g. /进化) and routes.
  ;(globalThis as any).__twinSystem = twinSystem
  ;(globalThis as any).__evolutionSystem = evolution

  const server = await buildServer(config, router, strategy, db, twinSystem)

  await server.listen({ port: config.server.port, host: config.server.host })
  console.log(`GeminiClaw listening on ${config.server.host}:${config.server.port}`)
  console.log(`Memory strategy: ${strategy.name}`)

  // Start enabled evolution engines after server is up.
  evolution.start()

  // Graceful shutdown
  const shutdown = () => {
    evolution.stop()
    server.close()
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch(err => {
  console.error("Fatal error:", err)
  process.exit(1)
})
