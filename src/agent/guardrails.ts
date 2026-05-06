/**
 * GuardrailController — tool call loop safety net
 *
 * Tracks per-tool failure counts and overall no-progress rounds.
 * Returns warn/halt decisions without any side effects.
 * Inspired by Hermes agent/tool_guardrails.py.
 */

import type { GuardrailConfig } from './types.js'

export type GuardrailDecision =
  | { action: 'continue' }
  | { action: 'warn'; message: string }
  | { action: 'halt'; message: string }

interface ToolStats {
  consecutiveFailures: number
  warnEmitted: boolean
}

export class GuardrailController {
  private readonly cfg: Required<GuardrailConfig>
  private toolStats = new Map<string, ToolStats>()
  private noProgressRounds = 0
  private noProgressWarnEmitted = false

  constructor(config?: GuardrailConfig) {
    this.cfg = {
      sameToolFailureWarnAfter: config?.sameToolFailureWarnAfter ?? 3,
      sameToolFailureHaltAfter: config?.sameToolFailureHaltAfter ?? 8,
      noProgressWarnAfter: config?.noProgressWarnAfter ?? 2,
      noProgressHaltAfter: config?.noProgressHaltAfter ?? 5,
    }
  }

  /**
   * Call after each tool execution to record the outcome.
   * Returns a decision: continue, warn, or halt.
   */
  record(toolName: string, isError: boolean): GuardrailDecision {
    let stats = this.toolStats.get(toolName)
    if (!stats) {
      stats = { consecutiveFailures: 0, warnEmitted: false }
      this.toolStats.set(toolName, stats)
    }

    if (isError) {
      stats.consecutiveFailures++
    } else {
      // Success resets the failure counter for this tool
      stats.consecutiveFailures = 0
      stats.warnEmitted = false
    }

    // Check halt threshold first
    if (stats.consecutiveFailures >= this.cfg.sameToolFailureHaltAfter) {
      return {
        action: 'halt',
        message: `Tool "${toolName}" failed ${stats.consecutiveFailures} times in a row. Stopping to avoid infinite loop.`,
      }
    }

    // Check warn threshold
    if (
      stats.consecutiveFailures >= this.cfg.sameToolFailureWarnAfter &&
      !stats.warnEmitted
    ) {
      stats.warnEmitted = true
      return {
        action: 'warn',
        message: `Tool "${toolName}" has failed ${stats.consecutiveFailures} times consecutively. Consider a different approach.`,
      }
    }

    return { action: 'continue' }
  }

  /**
   * Call at the end of each turn where no progress was made
   * (all tool calls failed, or the same tools keep being called with errors).
   */
  recordNoProgress(): GuardrailDecision {
    this.noProgressRounds++

    if (this.noProgressRounds >= this.cfg.noProgressHaltAfter) {
      return {
        action: 'halt',
        message: `No progress for ${this.noProgressRounds} turns. Stopping.`,
      }
    }

    if (
      this.noProgressRounds >= this.cfg.noProgressWarnAfter &&
      !this.noProgressWarnEmitted
    ) {
      this.noProgressWarnEmitted = true
      return {
        action: 'warn',
        message: `No progress for ${this.noProgressRounds} turns. Consider a different approach.`,
      }
    }

    return { action: 'continue' }
  }

  /** Call when a turn makes progress (at least one tool succeeded). */
  recordProgress(): void {
    this.noProgressRounds = 0
    this.noProgressWarnEmitted = false
  }

  reset(): void {
    this.toolStats.clear()
    this.noProgressRounds = 0
    this.noProgressWarnEmitted = false
  }
}
