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

export interface TextContentPart {
  type: "text"
  text: string
}

export type ContentPart = TextContentPart | { type: string; [key: string]: unknown }

export function messageText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content
  return (content as ContentPart[])
    .filter((p): p is TextContentPart => p.type === "text")
    .map(p => p.text)
    .join("\n")
}
