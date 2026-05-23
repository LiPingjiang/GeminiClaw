// src/providers/universal.ts
// UniversalProvider — routes to the correct protocol adapter based on config.api.

import type { ProviderConfig } from "../config/schema.js"
import type { Message, ChatOptions, ChatResponse, StreamChunk, Provider } from "./types.js"
import { anthMessagesChat, anthMessagesStream } from "./adapters/anth.js"
import { openaiCompletionsChat, openaiCompletionsStream } from "./adapters/openai.js"

export class UniversalProvider implements Provider {
  readonly name: string
  readonly models: string[]

  constructor(private config: ProviderConfig) {
    this.name = config.name
    this.models = config.models
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    switch (this.config.api) {
      case "anth-messages":
        return anthMessagesChat(this.config, messages, options)
      case "openai-completions":
        return openaiCompletionsChat(this.config, messages, options)
      default: {
        const _: never = this.config.api
        throw new Error(`Unsupported API protocol: ${_}`)
      }
    }
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    switch (this.config.api) {
      case "anth-messages":
        yield* anthMessagesStream(this.config, messages, options)
        return
      case "openai-completions":
        yield* openaiCompletionsStream(this.config, messages, options)
        return
      default: {
        const _: never = this.config.api
        throw new Error(`Unsupported API protocol: ${_}`)
      }
    }
  }
}
