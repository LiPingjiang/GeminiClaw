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

  // Provider 初始化
  const providers = config.providers.map(buildProvider)
  const router = new ProviderRouter(providers, config.routing)

  // DB 初始化（layered 策略需要）
  const dbPath = join(config.memory.dataDir, "geminiclaw.db")
  const db = openDb(dbPath)
  migrate(db)

  // 路由 provider（friday，用于 layered 策略的摘要/路由）
  const routerProvider = providers.find(p => p.name === "friday") ?? null

  // 记忆策略
  const strategy = buildStrategy(config, db, routerProvider)

  const server = await buildServer(config, router, strategy)

  await server.listen({ port: config.server.port, host: config.server.host })
  console.log(`GeminiClaw listening on ${config.server.host}:${config.server.port}`)
  console.log(`Memory strategy: ${strategy.name}`)
}

main().catch(err => {
  console.error("Fatal error:", err)
  process.exit(1)
})
