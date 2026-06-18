// src/agent/types.ts
import type { Message, ContentPart } from "../providers/types.js";

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Multimodal content blocks (images + text). When present, 'content' is the text-only fallback. */
  multimodal?: ContentPart[];
}

export type AgentMode = "auto" | "step" | "plan" | "high-confidence";

export interface GuardrailConfig {
  sameToolFailureWarnAfter?: number;
  sameToolFailureHaltAfter?: number;
  noProgressWarnAfter?: number;
  noProgressHaltAfter?: number;
  /** Warn after N identical results from idempotent tool (default: 2) */
  idempotentNoProgressWarnAfter?: number;
  /** Halt after N identical results from idempotent tool (default: 5) */
  idempotentNoProgressHaltAfter?: number;
  /** Global circuit breaker: halt if any tool signature repeats N times (default: 15) */
  globalCircuitBreakerThreshold?: number;
}

export interface PlanStep {
  id: string;
  description: string;
  toolHint?: string;
  status: "pending" | "in_progress" | "done" | "failed";
}

export interface PlanningConfig {
  enabled: boolean;
}

export interface UncertaintyItem {
  id: string;
  question: string;
  impact: "blocking" | "optional";
  resolved: boolean;
  answer?: string;
}

export interface UncertaintyConfig {
  enabled: boolean;
  maxRounds?: number;
}

export type PauseKind = "plan_ready" | "uncertainty_check";

export interface PausePayload {
  kind: PauseKind;
  data: unknown;
}

export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "message_delta"; delta: string }
  | { type: "turn_end"; message: Message; toolCallCount: number }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_end";
      toolCallId: string;
      toolName: string;
      result: ToolResult;
      isError: boolean;
      durationMs: number;
    }
  | {
      type: "agent_end";
      totalTurns: number;
      stopReason: "no_tool_calls" | "max_turns" | "aborted" | "error";
      model?: string;
      usage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number };
    }
  | { type: "paused"; pauseId: string; payload: PausePayload }
  | { type: "guardrail_warn"; toolName: string; message: string }
  | { type: "guardrail_halt"; toolName: string; message: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_end"; content: string; durationMs: number };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface BeforeToolCallContext {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  sessionId: string;
}

export interface AfterToolCallContext {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
  durationMs: number;
  sessionId: string;
}

export interface AgentConfig {
  maxTurns?: number;
  toolExecutionMode?: "parallel" | "sequential";
  maxToolOutputChars?: number;
  systemPrompt?: string;
  maxToolCallsPerTurn?: number;
  guardrails?: GuardrailConfig;
  planning?: PlanningConfig;
  uncertaintyCheck?: UncertaintyConfig;
}
