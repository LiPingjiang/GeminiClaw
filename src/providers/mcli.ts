import Anthropic from "@anthropic-ai/sdk"
import { AnthropicProvider } from "./anthropic.js"
import type { ProviderConfig } from "../config/schema.js"

export class McliProvider extends AnthropicProvider {
  constructor(config: ProviderConfig) {
    const client = new Anthropic({
      apiKey: config.apiKey ?? "mcli",
      baseURL: config.baseUrl,
      defaultHeaders: config.headers ?? {},
      timeout: 120_000,   // 2 minutes (prevent 10min+ hangs)
      maxRetries: 1,      // 1 retry only (prevent 30min total wait)
    })
    super(config, client)
  }
}
