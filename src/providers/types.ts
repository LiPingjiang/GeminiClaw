export interface Message {
  role: "user" | "assistant" | "system"
  content: string
}

export interface ChatOptions {
  model?: string
  maxTokens?: number
  temperature?: number
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface ChatResponse {
  content: string
  model: string
  usage?: TokenUsage
}

export interface StreamChunk {
  delta: string
  done: boolean
}

export interface Provider {
  name: string
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse>
  stream(messages: Message[], options?: ChatOptions): AsyncIterable<StreamChunk>
}
