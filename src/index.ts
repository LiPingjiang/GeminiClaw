import { loadConfig } from "./config/loader.js"
import { AnthropicProvider } from "./providers/anthropic.js"
import { McliProvider } from "./providers/mcli.js"
import { FridayProvider } from "./providers/friday.js"
import { ProviderRouter } from "./providers/router.js"
import { SessionMemory } from "./memory/session.js"
import { buildServer } from "./server/index.js"
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
  const memory = new SessionMemory()

  const server = await buildServer(config, router, memory)

  await server.listen({ port: config.server.port, host: config.server.host })
  console.log(`GeminiClaw listening on ${config.server.host}:${config.server.port}`)
}

main().catch(err => {
  console.error("Fatal error:", err)
  process.exit(1)
})
