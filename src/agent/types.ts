import type { Message } from '../providers/types.js'

export interface ToolResult {
  content: string
  isError?: boolean
}

// ─── Agent Mode ───────────────────────────────────────────────────────────────

export type AgentMode = 'auto' | 'step' | 'plan' | 'high-confidence'

// ─── Guardrails ───────────────────────────────────────────────────────────────

export interface GuardrailConfig {
  sameToolFailureWarnAfter?: number  // default 3
  sameToolFailureHaltAfter?: number  // default 8
  noProgressWarnAfter?: number       // default 2
  noProgressHaltAfter?: number       // default 5
}

// ─── Plan mode ────────────────────────────────────────────────────────────────

export interface PlanStep {
  id: string
  description: string
  toolHint?: string
  status: 'pending' | 'in_progress' | 'done' | 'failed'
}

export interface PlanningConfig {
  enabled: boolean
}

// ─── High-confidence mode ─────────────────────────────────────────────────────

export interface UncertaintyItem {
  id: string
  question: string
  impact: 'blocking' | 'optional'
  resolved: boolean
  answer?: string
}

export interface UncertaintyConfig {
  enabled: boolean
  maxRounds?: number  // default 2
}

// ─── Interrupt point ──────────────────────────────────────────────────────────

export type PauseKind = 'plan_ready' | 'uncertainty_check'

export interface PausePayload {
  kind: PauseKind
  data: unknown
}

// ─── Agent Events ─────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'message_delta'; delta: string }
  | { type: 'turn_end'; message: Message; toolCallCount: number }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; toolName: string; result: ToolResult; isError: boolean; durationMs: number }
  | { type: 'agent_end'; totalTurns: number; stopReason: 'no_tool_calls' | 'max_turns' | 'aborted' | 'provider_error'; error?: string }
  | { type: 'paused'; pauseId: string; payload: PausePayload }
  | { type: 'guardrail_warn'; toolName: string; message: string }
  | { type: 'guardrail_halt'; toolName: string; message: string }

// ─── Tool call ────────────────────────────────────────────────────────────────

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

// ─── Agent Config ─────────────────────────────────────────────────────────────

export interface AgentConfig {
  maxTurns?: number
  toolExecutionMode?: 'parallel' | 'sequential'
  maxToolOutputChars?: number
  systemPrompt?: string
  // Mode behavior layers (composable)
  maxToolCallsPerTurn?: number        // step mode: set to 1
  guardrails?: GuardrailConfig        // loop guardrails
  planning?: PlanningConfig           // plan mode (requires interrupt point)
  uncertaintyCheck?: UncertaintyConfig // high-confidence mode (requires interrupt point)
}
