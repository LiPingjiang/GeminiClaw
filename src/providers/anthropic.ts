import Anthropic from "@anthropic-ai/sdk"
import type { ProviderConfig } from "../config/schema.js"
import type {
  Message,
  ContentPart,
  ToolDefinition,
  ToolCall,
  ChatOptions,
  ChatResponse,
  StreamChunk,
  Provider,
} from "./types.js"

// ── Tool format converters ────────────────────────────────────────────────────────────

/** OpenAI tool_choice → Anthropic tool_choice */
function toAnthropicToolChoice(
  tc: ChatOptions["tool_choice"],
): Anthropic.MessageCreateParams["tool_choice"] | undefined {
  if (!tc) return undefined
  if (tc === "auto") return { type: "auto" }
  if (tc === "none") return { type: "none" }
  if (tc === "required") return { type: "any" }  // Anthropic uses "any" for required
  if (typeof tc === "object" && tc.type === "function") {
    return { type: "tool", name: tc.function.name }
  }
  return undefined
}

/** OpenAI ToolDefinition → Anthropic Tool */
function toAnthropicTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.function.name,
    description: tool.function.description ?? "",
    input_schema: (tool.function.parameters ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
  }
}

/** Anthropic ToolUseBlock[] → OpenAI ToolCall[] */
function fromAnthropicToolUse(blocks: Anthropic.ToolUseBlock[]): ToolCall[] {
  return blocks.map(b => ({
    id: b.id,
    type: "function" as const,
    function: {
      name: b.name,
      arguments: JSON.stringify(b.input),
    },
  }))
}

/** Convert messages with role=tool to Anthropic tool_result blocks */
function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = []

  for (const m of messages) {
    if (m.role === "system") continue

    if (m.role === "tool") {
      // tool result: wrap as user message with tool_result block
      const last = result[result.length - 1]
      const block: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: m.tool_call_id ?? "",
        content: typeof m.content === "string" ? m.content : "",
      }
      if (last && last.role === "user" && Array.isArray(last.content)) {
        // merge consecutive tool results into one user message
        ;(last.content as Anthropic.ContentBlockParam[]).push(block)
      } else {
        result.push({ role: "user", content: [block] })
      }
      continue
    }

    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      // assistant called tools: emit text block + tool_use blocks
      const content: Anthropic.ContentBlockParam[] = []
      if (m.content && (typeof m.content === "string" ? m.content : "").trim()) {
        content.push({ type: "text", text: typeof m.content === "string" ? m.content : "" })
      }
      for (const tc of m.tool_calls) {
        let input: unknown = {}
        try { input = JSON.parse(tc.function.arguments) } catch { /* ignore */ }
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input })
      }
      result.push({ role: "assistant", content })
      continue
    }

    result.push({
      role: m.role as "user" | "assistant",
      content: toAnthropicContent(m.content),
    })
  }

  return result
}

/**
 * Convert internal ContentPart[] to Anthropic SDK content blocks.
 * Supports text and image_url (base64 data: URI or https URL).
 */
function toAnthropicContent(
  content: string | ContentPart[],
): string | Anthropic.MessageParam["content"] {
  if (typeof content === "string") return content

  return content.map((part): Anthropic.ContentBlockParam => {
    if (part.type === "text") {
      return { type: "text", text: part.text }
    }
    // image_url: support data URI (base64) and https URL
    const url = part.image_url.url
    if (url.startsWith("data:")) {
      // data:image/jpeg;base64,<data>
      const [meta, data] = url.split(",", 2)
      const mediaType = (meta.split(";")[0].split(":")[1] ?? "image/jpeg") as
        | "image/jpeg"
        | "image/png"
        | "image/gif"
        | "image/webp"
      return {
        type: "image",
        source: { type: "base64", media_type: mediaType, data },
      }
    }
    // https URL
    return {
      type: "image",
      source: { type: "url", url },
    }
  })
}

export class AnthropicProvider implements Provider {
  readonly name: string
  readonly models: string[]
  private client: Anthropic
  private defaultModel: string
  /** Whether this endpoint supports tool_choice parameter (official Anthropic API does; mcli proxy does not) */
  private supportsToolChoice: boolean

  constructor(config: ProviderConfig, clientOverride?: Anthropic) {
    this.name = config.name
    this.models = config.models
    this.defaultModel = config.models[0]
    this.client =
      clientOverride ??
      new Anthropic({
        apiKey: config.apiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      })
    // mcli and other non-official proxies may not support tool_choice
    // detect by checking if baseUrl is the official Anthropic API
    const baseUrl = config.baseUrl ?? ""
    this.supportsToolChoice = !baseUrl || baseUrl.includes("api.anthropic.com")
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const model = options?.model ?? this.defaultModel
    const systemMessages = messages.filter(m => m.role === "system")
    const anthropicMessages = toAnthropicMessages(messages)
    const tools = options?.tools?.map(toAnthropicTool)
    const toolChoice = this.supportsToolChoice ? toAnthropicToolChoice(options?.tool_choice) : undefined

    const response = await this.client.messages.create({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(systemMessages.length > 0
        ? { system: systemMessages.map(m => typeof m.content === "string" ? m.content : m.content.map(p => p.type === "text" ? p.text : "").join("")).join("\n") }
        : {}),
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      messages: anthropicMessages,
    })

    // mcli proxy returns stop_reason=error when it doesn't support a feature (e.g. tool_use)
    // treat this as a provider failure so router can fall back
    if ((response.stop_reason as string) === "error") {
      const errText = response.content.find(b => b.type === "text")
      throw new Error(`Provider returned stop_reason=error: ${errText?.type === "text" ? errText.text : "unknown error"}`)
    }

    const textBlock = response.content.find(b => b.type === "text")
    const content = textBlock && textBlock.type === "text" ? textBlock.text : ""
    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    const tool_calls = toolUseBlocks.length > 0 ? fromAnthropicToolUse(toolUseBlocks) : undefined

    return {
      content,
      model: response.model,
      finish_reason: response.stop_reason ?? undefined,
      tool_calls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    }
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    const model = options?.model ?? this.defaultModel
    const systemMessages = messages.filter(m => m.role === "system")
    const anthropicMessages = toAnthropicMessages(messages)
    const tools = options?.tools?.map(toAnthropicTool)
    const toolChoice = this.supportsToolChoice ? toAnthropicToolChoice(options?.tool_choice) : undefined

    // Accumulate tool_use input JSON across input_json_delta events
    const toolInputBuffers = new Map<number, { id: string; name: string; json: string }>()

    const stream = this.client.messages.stream({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(systemMessages.length > 0
        ? { system: systemMessages.map(m => typeof m.content === "string" ? m.content : m.content.map(p => p.type === "text" ? p.text : "").join("")).join("\n") }
        : {}),
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      messages: anthropicMessages,
    })

    for await (const event of stream) {
      if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        toolInputBuffers.set(event.index, {
          id: event.content_block.id,
          name: event.content_block.name,
          json: "",
        })
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { delta: event.delta.text, done: false }
        } else if (event.delta.type === "input_json_delta") {
          const buf = toolInputBuffers.get(event.index)
          if (buf) buf.json += event.delta.partial_json
        }
      } else if (event.type === "message_stop") {
        // emit accumulated tool_calls as a special delta marker
        if (toolInputBuffers.size > 0) {
          const tool_calls: ToolCall[] = Array.from(toolInputBuffers.values()).map(buf => ({
            id: buf.id,
            type: "function" as const,
            function: { name: buf.name, arguments: buf.json },
          }))
          yield { delta: "", done: false, tool_calls } as StreamChunk & { tool_calls: ToolCall[] }
        }
      }
    }

    yield { delta: "", done: true }
  }
}
