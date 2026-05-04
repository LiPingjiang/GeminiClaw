import Anthropic from "@anthropic-ai/sdk"
import type { ProviderConfig } from "../config/schema.js"
import type {
  Message,
  ChatOptions,
  ChatResponse,
  StreamChunk,
  Provider,
} from "./types.js"

export class AnthropicProvider implements Provider {
  readonly name: string
  private client: Anthropic
  private defaultModel: string

  constructor(config: ProviderConfig, clientOverride?: Anthropic) {
    this.name = config.name
    this.defaultModel = config.models[0]
    this.client =
      clientOverride ??
      new Anthropic({
        apiKey: config.apiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      })
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const model = options?.model ?? this.defaultModel
    const systemMessages = messages.filter(m => m.role === "system")
    const nonSystemMessages = messages.filter(m => m.role !== "system")

    const response = await this.client.messages.create({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(systemMessages.length > 0
        ? { system: systemMessages.map(m => m.content).join("\n") }
        : {}),
      messages: nonSystemMessages.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    })

    const textBlock = response.content.find(b => b.type === "text")
    const content = textBlock && textBlock.type === "text" ? textBlock.text : ""

    return {
      content,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    }
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    const model = options?.model ?? this.defaultModel
    const systemMessages = messages.filter(m => m.role === "system")
    const nonSystemMessages = messages.filter(m => m.role !== "system")

    const stream = this.client.messages.stream({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(systemMessages.length > 0
        ? { system: systemMessages.map(m => m.content).join("\n") }
        : {}),
      messages: nonSystemMessages.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    })

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield { delta: event.delta.text, done: false }
      }
    }

    yield { delta: "", done: true }
  }
}
