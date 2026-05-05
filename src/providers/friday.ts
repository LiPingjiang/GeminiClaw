import type { ProviderConfig } from "../config/schema.js"
import type { Message, ChatOptions, ChatResponse, StreamChunk, Provider } from "./types.js"

export class FridayProvider implements Provider {
  readonly name: string
  private apiKey: string
  private baseUrl: string
  private defaultModel: string

  constructor(config: ProviderConfig) {
    this.name = config.name
    this.apiKey = config.apiKey ?? ""
    this.baseUrl = (config.baseUrl ?? "").replace(/\/$/, "")
    this.defaultModel = config.models[0]
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
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        max_tokens: options?.maxTokens ?? 4096,
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`friday API error ${res.status}: ${text}`)
    }

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>
      model: string
      usage?: { prompt_tokens: number; completion_tokens: number }
    }

    return {
      content: data.choices[0]?.message?.content ?? "",
      model: data.model,
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
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        max_tokens: options?.maxTokens ?? 4096,
        stream: true,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`friday API error ${res.status}: ${text}`)
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
          const evt = JSON.parse(raw) as { choices?: Array<{ delta?: { content?: string } }> }
          const delta = evt.choices?.[0]?.delta?.content ?? ""
          if (delta) yield { delta, done: false }
        } catch { /* skip malformed */ }
      }
    }
    yield { delta: "", done: true }
  }
}
