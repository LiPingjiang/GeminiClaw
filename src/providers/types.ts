// providers/types.ts — merged: keeps Message.content as string (test-compatible)
// + adds tool types needed by anthropic.ts

export interface TextContentPart {
  type: "text"
  text: string
}

export interface ImageContentPart {
  type: "image_url"
  image_url: { url: string; detail?: string }
}

export type ContentPart = TextContentPart | ImageContentPart

export function messageText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content
  return (content as ContentPart[])
    .filter((p): p is TextContentPart => p.type === "text")
    .map(p => p.text)
    .join("\n")
}

// ── Tool definitions (OpenAI-compatible format) ──────────────────────────────
export interface ToolFunction {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface ToolDefinition {
  type: "function"
  function: ToolFunction
}

// ── Tool call in assistant message ───────────────────────────────────────────
export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

// ── Core message types ────────────────────────────────────────────────────────
export interface Message {
  role: "user" | "assistant" | "system" | "tool"
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ChatOptions {
  model?: string
  maxTokens?: number
  temperature?: number
  tools?: ToolDefinition[]
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } }
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface ChatResponse {
  content: string
  model: string
  usage?: TokenUsage
  tool_calls?: ToolCall[]
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
