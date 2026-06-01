import type { Provider, Message, ChatOptions, ChatResponse, StreamChunk } from "./types.js"
import type { RoutingConfig } from "../config/schema.js"

function parseRoute(route: string): { providerName: string; model: string } {
  const idx = route.indexOf("/")
  if (idx === -1) return { providerName: route, model: route }
  return { providerName: route.slice(0, idx), model: route.slice(idx + 1) }
}

export class ProviderRouter {
  private providers: Map<string, Provider>
  private routing: RoutingConfig

  constructor(providers: Provider[], routing: RoutingConfig) {
    this.providers = new Map(providers.map(p => [p.name, p]))
    this.routing = routing
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    // default first, then fallback chain
    const chain = [this.routing.default, ...this.routing.fallback]

    const errors: string[] = []

    for (const route of chain) {
      const { providerName, model } = parseRoute(route)
      const provider = this.providers.get(providerName)
      if (!provider) {
        errors.push(`Provider "${providerName}" not found`)
        continue
      }
      try {
        return await provider.chat(messages, { ...options, model })
      } catch (err) {
        errors.push(`${providerName}: ${(err as Error).message}`)
      }
    }

    throw new Error(`All providers failed:\n${errors.join("\n")}`)
  }

  listModels(): string[] {
    const models: string[] = []
    for (const [providerName, provider] of this.providers) {
      for (const model of provider.models ?? []) {
        models.push(`${providerName}/${model}`)
      }
    }
    // also include routing defaults
    if (models.length === 0) {
      models.push(this.routing.default, ...this.routing.fallback)
    }
    return [...new Set(models)]
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    const route = this.routing.default
    const { providerName, model } = parseRoute(route)
    const provider = this.providers.get(providerName)
    if (!provider) throw new Error(`Provider "${providerName}" not found`)
    yield* provider.stream(messages, { ...options, model })
  }
}
