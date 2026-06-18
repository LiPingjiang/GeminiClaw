export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

export type TuiEvent =
  | { kind: 'delta'; content: string }
  | { kind: 'turn_end'; toolCallCount: number }
  | { kind: 'user_message'; content: string }
  | { kind: 'response'; content: string }
  | { kind: 'tool_start'; name: string; args: unknown }
  | { kind: 'tool_end'; name: string; durationMs: number; isError: boolean; result: string }
  | { kind: 'turn_start'; turn: number }
  | { kind: 'agent_end'; totalTurns: number; stopReason: string; model?: string; usage?: TokenUsage }
  | { kind: 'error'; message: string }
  | { kind: 'system'; message: string }
  | { kind: 'guardrail_warn'; toolName: string; message: string }
  | { kind: 'guardrail_halt'; toolName: string; message: string }
  | { kind: 'thinking_delta'; delta: string }
  | { kind: 'thinking_end'; content: string; durationMs: number }
  | { kind: 'diff'; filename: string; before: string; after: string }

export interface HeaderState {
  status: 'idle' | 'running' | 'error'
  turn?: number
  maxTurns?: number
  currentTool?: string
  sessionId?: string
  model?: string
  elapsedMs?: number
  // Cumulative session stats
  totalInputTokens?: number
  totalOutputTokens?: number
  totalCacheReadTokens?: number
  totalCacheCreationTokens?: number
  contextWindowSize?: number
  lastTurnTokens?: number
  // Codebase indexing status
  lspServer?: string
  lspReady?: boolean
  fileIndexSize?: number
  thinkingEnabled?: boolean
}
