// src/agent/guardrails.ts
/**
 * GuardrailController — tool call loop safety net
 *
 * Tracks per-tool failure counts and overall no-progress rounds.
 * Returns warn/halt decisions without any side effects.
 */
import type { GuardrailConfig } from "./types.js";

type Decision =
  | { action: "continue" }
  | { action: "warn"; message: string }
  | { action: "halt"; message: string };

interface ToolStats {
  consecutiveFailures: number;
  warnEmitted: boolean;
}

export class GuardrailController {
  private cfg: Required<GuardrailConfig>;
  private toolStats = new Map<string, ToolStats>();
  private noProgressRounds = 0;
  private noProgressWarnEmitted = false;

  constructor(config?: GuardrailConfig) {
    this.cfg = {
      sameToolFailureWarnAfter: config?.sameToolFailureWarnAfter ?? 3,
      sameToolFailureHaltAfter: config?.sameToolFailureHaltAfter ?? 8,
      noProgressWarnAfter: config?.noProgressWarnAfter ?? 2,
      noProgressHaltAfter: config?.noProgressHaltAfter ?? 5,
    };
  }

  record(toolName: string, isError: boolean): Decision {
    let stats = this.toolStats.get(toolName);
    if (!stats) {
      stats = { consecutiveFailures: 0, warnEmitted: false };
      this.toolStats.set(toolName, stats);
    }
    if (isError) {
      stats.consecutiveFailures++;
    } else {
      stats.consecutiveFailures = 0;
      stats.warnEmitted = false;
    }
    if (stats.consecutiveFailures >= this.cfg.sameToolFailureHaltAfter) {
      return {
        action: "halt",
        message: `Tool "${toolName}" failed ${stats.consecutiveFailures} times in a row. Stopping to avoid infinite loop.`,
      };
    }
    if (stats.consecutiveFailures >= this.cfg.sameToolFailureWarnAfter && !stats.warnEmitted) {
      stats.warnEmitted = true;
      return {
        action: "warn",
        message: `Tool "${toolName}" has failed ${stats.consecutiveFailures} times consecutively. Consider a different approach.`,
      };
    }
    return { action: "continue" };
  }

  recordNoProgress(): Decision {
    this.noProgressRounds++;
    if (this.noProgressRounds >= this.cfg.noProgressHaltAfter) {
      return {
        action: "halt",
        message: `No progress for ${this.noProgressRounds} turns. Stopping.`,
      };
    }
    if (this.noProgressRounds >= this.cfg.noProgressWarnAfter && !this.noProgressWarnEmitted) {
      this.noProgressWarnEmitted = true;
      return {
        action: "warn",
        message: `No progress for ${this.noProgressRounds} turns. Consider a different approach.`,
      };
    }
    return { action: "continue" };
  }

  recordProgress(): void {
    this.noProgressRounds = 0;
    this.noProgressWarnEmitted = false;
  }

  reset(): void {
    this.toolStats.clear();
    this.noProgressRounds = 0;
    this.noProgressWarnEmitted = false;
  }
}
