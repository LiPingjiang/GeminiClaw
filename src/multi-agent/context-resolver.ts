/**
 * Context Resolver — Determines the effective context mode for a sub-agent,
 * applying token threshold degradation when necessary.
 *
 * This implements the OpenClaw-inspired pattern:
 * - fork mode: full parent context + skills + per-agent memory
 * - isolated mode: skills + task only (no parent context)
 * - lightweight mode: task only (no skills, minimal prompt)
 *
 * Automatic degradation:
 * - If fork prompt > 100K tokens → degrade to isolated
 * - If isolated prompt > 150K tokens → degrade to lightweight
 * - If lightweight prompt > 180K tokens → refuse to spawn
 */

import { estimateTokens } from "../memory/working-memory.js"
import type { ContextMode } from "./types.js"
import { TOKEN_THRESHOLD } from "./types.js"

export interface ContextResolutionInput {
  /** Requested context mode */
  requestedMode: ContextMode
  /** Base system prompt (global AGENT.md + skills) */
  basePrompt: string
  /** Parent conversation context (compressed summary) — only used in fork mode */
  parentContext?: string
  /** Per-agent memory content — only used in fork mode */
  agentMemory?: string
  /** Task description */
  taskDescription: string
}

export interface ContextResolutionResult {
  /** The effective mode after degradation */
  effectiveMode: ContextMode
  /** Whether degradation occurred */
  degraded: boolean
  /** Original requested mode (for logging) */
  requestedMode: ContextMode
  /** The system prompt to use (already assembled) */
  systemPrompt: string | null
  /** Parent context to pass (null if not fork mode) */
  parentContext: string | null
  /** Estimated token count of the final prompt */
  estimatedTokens: number
  /** Degradation reason (if degraded) */
  degradationReason?: string
  /** Whether the task should be refused (exceeds absolute max) */
  refused: boolean
}

/**
 * Resolve the effective context mode, applying token budget constraints.
 *
 * Returns the assembled system prompt and effective mode.
 * If token budget is exceeded, automatically degrades to a lighter mode.
 */
export function resolveContext(input: ContextResolutionInput): ContextResolutionResult {
  const { requestedMode, basePrompt, parentContext, agentMemory, taskDescription } = input

  // Try the requested mode first
  let result = tryMode(requestedMode, basePrompt, parentContext, agentMemory, taskDescription)

  // Degradation chain: fork → isolated → lightweight → refuse
  if (result.refused && requestedMode === "fork") {
    // Try isolated
    result = tryMode("isolated", basePrompt, undefined, undefined, taskDescription)
    if (!result.refused) {
      return {
        ...result,
        degraded: true,
        requestedMode,
        degradationReason: `fork 模式预估 token 超过阈值 ${TOKEN_THRESHOLD.FORK_TO_ISOLATED}，降级为 isolated`,
      }
    }
  }

  if (result.refused && (requestedMode === "fork" || requestedMode === "isolated")) {
    // Try lightweight
    result = tryMode("lightweight", basePrompt, undefined, undefined, taskDescription)
    if (!result.refused) {
      return {
        ...result,
        degraded: true,
        requestedMode,
        degradationReason: `isolated 模式预估 token 超过阈值 ${TOKEN_THRESHOLD.ISOLATED_TO_LIGHTWEIGHT}，降级为 lightweight`,
      }
    }
  }

  // If still refused after all degradation attempts
  if (result.refused) {
    return {
      effectiveMode: "lightweight",
      degraded: true,
      requestedMode,
      systemPrompt: null,
      parentContext: null,
      estimatedTokens: result.estimatedTokens,
      degradationReason: `所有模式均超过绝对上限 ${TOKEN_THRESHOLD.ABSOLUTE_MAX} tokens，拒绝生成`,
      refused: true,
    }
  }

  return {
    ...result,
    degraded: result.effectiveMode !== requestedMode,
    requestedMode,
  }
}

function tryMode(
  mode: ContextMode,
  basePrompt: string,
  parentContext: string | undefined,
  agentMemory: string | undefined,
  taskDescription: string,
): ContextResolutionResult {
  let systemPromptContent: string
  let effectiveParentContext: string | null = null

  switch (mode) {
    case "fork": {
      // Full: base + agent memory + parent context (passed separately for prompt assembly)
      const parts = [basePrompt]
      if (agentMemory) parts.push(agentMemory)
      systemPromptContent = parts.join("\n\n")
      effectiveParentContext = parentContext ?? null
      break
    }
    case "isolated": {
      // Skills + task only, no parent context or agent memory
      systemPromptContent = basePrompt
      break
    }
    case "lightweight": {
      // Minimal: just a basic role + task description, no skills
      systemPromptContent = [
        "你是一个专注的子 Agent，负责执行单一任务。",
        "高效使用工具完成任务，完成后报告结果。",
      ].join("\n")
      break
    }
  }

  // Estimate total tokens (system prompt + task + parent context)
  const totalContent = [
    systemPromptContent,
    taskDescription,
    effectiveParentContext ?? "",
  ].join("\n")
  const estimatedTokens = estimateTokens(totalContent)

  // Check thresholds
  const threshold = getThresholdForMode(mode)
  const refused = estimatedTokens > threshold

  return {
    effectiveMode: mode,
    degraded: false,
    requestedMode: mode,
    systemPrompt: systemPromptContent,
    parentContext: effectiveParentContext,
    estimatedTokens,
    refused,
  }
}

function getThresholdForMode(mode: ContextMode): number {
  switch (mode) {
    case "fork":
      return TOKEN_THRESHOLD.FORK_TO_ISOLATED
    case "isolated":
      return TOKEN_THRESHOLD.ISOLATED_TO_LIGHTWEIGHT
    case "lightweight":
      return TOKEN_THRESHOLD.ABSOLUTE_MAX
  }
}
