import type { Message } from '../providers/types.js'

export interface ToolResult {
  content: string
  isError?: boolean
}

export type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'message_delta'; delta: string }
  | { type: 'turn_end'; message: Message; toolCallCount: number }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; toolName: string; result: ToolResult; isError: boolean; durationMs: number }
  | { type: 'agent_end'; totalTurns: number; stopReason: 'no_tool_calls' | 'max_turns' | 'aborted' }

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface BeforeToolCallContext {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  sessionId: string
}

export interface AfterToolCallContext {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  result: ToolResult
  durationMs: number
  sessionId: string
}

export interface AgentConfig {
  maxTurns?: number
  toolExecutionMode?: 'parallel' | 'sequential'
  maxToolOutputChars?: number
  systemPrompt?: string
}
