import type { Provider, Message, ChatOptions, ChatResponse, StreamChunk } from "./types.js"
import type { RoutingConfig } from "../config/schema.js"
import { stripToolXml, detectRepetitionLoop } from "../utils/strip-tool-xml.js"

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
    // 路由链：default 优先，然后按 fallback 顺序
    const chain = [this.routing.default, ...this.routing.fallback]

    const errors: string[] = []

    for (let i = 0; i < chain.length; i++) {
      const route = chain[i]
      const { providerName, model } = parseRoute(route)
      const provider = this.providers.get(providerName)
      if (!provider) {
        errors.push(`Provider "${providerName}" not found`)
        continue
      }
      try {
        const response = await provider.chat(messages, { ...options, model })
        const sysMsg = messages.find(m => m.role === "system")
        const sysLen = sysMsg ? (typeof sysMsg.content === "string" ? sysMsg.content.length : 0) : 0
        const isFallback = i > 0
        if (isFallback) {
          console.log(`[ProviderRouter] ⚠ FALLBACK → ${providerName}/${model} | msgs=${messages.length} sysPrompt=${sysLen}chars`)
        } else {
          console.log(`[ProviderRouter] ✓ ${providerName}/${model} | msgs=${messages.length} sysPrompt=${sysLen}chars`)
        }

        // ── Sanitize response content ──
        let content = response.content
        if (content) {
          // Strip leaked internal reasoning tags (antThinking, thinking, etc.)
          content = stripToolXml(content)
          // Detect repetition loop (model stuck generating same block)
          const cleaned = detectRepetitionLoop(content)
          if (cleaned !== null) {
            console.log(`[ProviderRouter] ⚠ Repetition loop detected in ${providerName}/${model} output, truncated from ${content.length} to ${cleaned.length} chars`)
            content = cleaned || "（模型响应异常，请重试）"
          }
        }

        return {
          ...response,
          content,
          routeUsed: isFallback ? `${providerName}/${model}` : undefined,
        }
      } catch (err) {
        console.error(`[ProviderRouter] ✗ ${providerName}/${model} failed: ${(err as Error).message}`)
        errors.push(`${providerName}/${model}: ${(err as Error).message}`)
      }
    }

    throw new Error(`All providers failed:\n${errors.join("\n")}`)
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    const route = this.routing.default
    const { providerName, model } = parseRoute(route)
    const provider = this.providers.get(providerName)
    if (!provider) throw new Error(`Provider "${providerName}" not found`)
    yield* provider.stream(messages, { ...options, model })
  }
}
