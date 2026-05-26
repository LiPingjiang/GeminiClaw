// src/index.ts
import { loadConfig } from "./config/loader.js"
import { AnthropicProvider } from "./providers/anthropic.js"
import { McliProvider } from "./providers/mcli.js"
import { FridayProvider } from "./providers/friday.js"
import { ProviderRouter } from "./providers/router.js"
import { buildStrategy } from "./memory/strategy.js"
import { buildServer } from "./server/index.js"
import { openDb } from "./db/client.js"
import { migrate } from "./db/schema.js"
import { join } from "path"
import type { Provider } from "./providers/types.js"
import type { ProviderConfig } from "./config/schema.js"

function buildProvider(config: ProviderConfig): Provider {
  switch (config.type) {
    case "anthropic":
      return new AnthropicProvider(config)
    case "mcli":
      return new McliProvider(config)
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
  const server = await buildServer(config, router, strategy, db)
  await server.listen({ port: config.server.port, host: config.server.host })
  console.log(`GeminiClaw listening on ${config.server.host}:${config.server.port}`)
  console.log(`Memory strategy: ${strategy.name}`)
}

main().catch(err => {
  console.error("Fatal error:", err)
  process.exit(1)
})
