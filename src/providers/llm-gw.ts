import Anthropic from "@anthropic-ai/sdk"
import { AnthropicProvider } from "./anthropic.js"
import type { ProviderConfig } from "../config/schema.js"

/**
 * LlmGwProvider — Anthropic-compatible provider via llm-gw gateway.
 * Same protocol as McliProvider, but with its own type identity
 * so config validation distinguishes them.
 */
export class LlmGwProvider extends AnthropicProvider {
  constructor(config: ProviderConfig) {
    const client = new Anthropic({
      apiKey: config.apiKey ?? "llm-gw",
      baseURL: config.baseUrl,
      defaultHeaders: config.headers ?? {},
    })
    super(config, client)
  }
}
