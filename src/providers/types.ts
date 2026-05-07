export interface ImageContentPart {
  type: "image_url"
  image_url: { url: string; detail?: string }
}

export interface TextContentPart {
  type: "text"
  text: string
}

export type ContentPart = TextContentPart | ImageContentPart

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
    arguments: string  // JSON string
  }
}

// ── Message ──────────────────────────────────────────────────────────────────
export interface Message {
  role: "user" | "assistant" | "system" | "tool"
  content: string | ContentPart[]
  tool_calls?: ToolCall[]       // assistant → model called tools
  tool_call_id?: string         // tool → result for this call
}

/** Extract plain text from a message content (string or multimodal array). */
export function messageText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content
  return content.filter((p): p is TextContentPart => p.type === "text").map(p => p.text).join("\n")
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
  finish_reason?: string
}

export interface StreamChunk {
  delta: string
  done: boolean
  tool_calls?: ToolCall[]  // emitted when model calls tools (streaming)
}

export interface Provider {
  name: string
  models?: string[]  // list of model ids this provider supports
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse>
  stream(messages: Message[], options?: ChatOptions): AsyncIterable<StreamChunk>
}
