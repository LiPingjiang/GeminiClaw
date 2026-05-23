import type { ProviderConfig } from "../config/schema.js"
import type { Message, ChatOptions, ChatResponse, StreamChunk, Provider, ToolCall } from "./types.js"

/** Generic OpenAI-compatible provider. Works with OpenAI, DeepSeek, Gemini, Hunyuan, Ollama etc. */
export class OpenAIProvider implements Provider {
  readonly name: string
  readonly models: string[]
  private apiKey: string
  private baseUrl: string
  private defaultModel: string

  constructor(config: ProviderConfig) {
    this.name = config.name
    this.models = config.models
    this.apiKey = config.apiKey ?? ""
    this.baseUrl = (config.baseUrl ?? "").replace(/\/$/, "")
    this.defaultModel = config.models[0]
  }

  /**
   * Normalize messages for Friday/Gemini:
   * - Gemini thinking models require thought_signature on historical tool calls,
   *   which we don't track. Instead, flatten tool_calls/tool results into text.
   * - system messages are folded into the first user message.
   */
  private normalizeFridayMessages(messages: Message[]): Array<{ role: string; content: string }> {
    const systemParts: string[] = []
    const result: Array<{ role: string; content: string }> = []

    for (const m of messages) {
      if (m.role === 'system') {
        systemParts.push(typeof m.content === 'string' ? m.content : '')
        continue
      }
      if (m.role === 'tool') {
        // Fold tool result into a user message
        const text = `[Tool result${m.tool_call_id ? ` (${m.tool_call_id})` : ''}]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`
        const last = result[result.length - 1]
        if (last && last.role === 'user') {
          last.content += '\n' + text
        } else {
          result.push({ role: 'user', content: text })
        }
        continue
      }
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        // Flatten tool_calls into text to avoid thought_signature requirement
        const toolText = m.tool_calls.map(tc =>
          `[Called tool: ${tc.function.name}(${tc.function.arguments})]`
        ).join('\n')
        const text = [typeof m.content === 'string' ? m.content : '', toolText].filter(Boolean).join('\n')
        result.push({ role: 'assistant', content: text })
        continue
      }
      result.push({ role: m.role as string, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })
    }

    // Prepend system content to first user message
    if (systemParts.length > 0 && result.length > 0) {
      const firstUser = result.find(m => m.role === 'user')
      if (firstUser) {
        firstUser.content = systemParts.join('\n') + '\n\n' + firstUser.content
      }
    }

    return result
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const model = options?.model ?? this.defaultModel
    const url = `${this.baseUrl}/chat/completions`

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: this.normalizeFridayMessages(messages),
        max_tokens: options?.maxTokens ?? 4096,
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options?.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
        ...(options?.tool_choice ? { tool_choice: options.tool_choice } : {}),
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`openai API error ${res.status}: ${text}`)
    }

    const data = await res.json() as {
      choices: Array<{
        message: { content: string | null; tool_calls?: ToolCall[] }
        finish_reason?: string
      }>
      model: string
      usage?: { prompt_tokens: number; completion_tokens: number }
    }

    const msg = data.choices[0]?.message
    const tool_calls = msg?.tool_calls && msg.tool_calls.length > 0 ? msg.tool_calls : undefined

    return {
      content: msg?.content ?? "",
      model: data.model,
      finish_reason: data.choices[0]?.finish_reason,
      tool_calls,
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
        : undefined,
    }
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    const model = options?.model ?? this.defaultModel
    const url = `${this.baseUrl}/chat/completions`

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        })),
        max_tokens: options?.maxTokens ?? 4096,
        stream: true,
        ...(options?.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
        ...(options?.tool_choice ? { tool_choice: options.tool_choice } : {}),
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`openai API error ${res.status}: ${text}`)
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const raw = line.slice(6).trim()
        if (raw === "[DONE]") { yield { delta: "", done: true }; return }
        try {
          const evt = JSON.parse(raw) as {
            choices?: Array<{
              delta?: { content?: string; tool_calls?: ToolCall[] }
              finish_reason?: string
            }>
          }
          const choice = evt.choices?.[0]
          const delta = choice?.delta?.content ?? ""
          if (delta) yield { delta, done: false }
          // emit tool_calls when finish_reason is tool_calls
          if (choice?.finish_reason === "tool_calls" && choice.delta?.tool_calls) {
            yield { delta: "", done: false, tool_calls: choice.delta.tool_calls }
          }
        } catch { /* skip malformed */ }
      }
    }
    yield { delta: "", done: true }
  }
}
