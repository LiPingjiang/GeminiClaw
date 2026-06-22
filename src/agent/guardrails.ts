// src/agent/guardrails.ts
/**
 * GuardrailController — tool call loop safety net
 *
 * Detects three failure modes:
 * 1. Same tool failing repeatedly (existing)
 * 2. No progress rounds (existing)
 * 3. [NEW] Idempotent tool returning same result — "successful but useless" loops
 * 4. [NEW] Global circuit breaker — any identical signature repeated too many times
 *
 * Inspired by Hermes (idempotent_no_progress) and OpenClaw (tool-loop-detection).
 */
import { createHash } from "crypto";
import type { GuardrailConfig } from "./types.js";

type Decision =
  | { action: "continue" }
  | { action: "warn"; message: string }
  | { action: "halt"; message: string }
  | { action: "block"; message: string };

interface ToolStats {
  consecutiveFailures: number;
  warnEmitted: boolean;
}

interface NoProgressRecord {
  resultHash: string;
  repeatCount: number;
  warnEmitted: boolean;
}

/**
 * Tools that are read-only / idempotent — repeated calls with same args
 * should yield same results, so repeating them is pointless.
 */
const IDEMPOTENT_TOOLS = new Set([
  "web_search",
  "read_file",
  "search_files",
  "grep",
  "glob",
  "list_dir",
  "file_read",
  "read",
  "web_fetch",
  "web_browse",
  "exec",
  "sandbox_exec",
  "db_query",
]);

/** Compute a short hash for dedup purposes. */
function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** Create a canonical signature for a tool call (tool name + sorted args). */
function toolSignature(toolName: string, args: Record<string, unknown>): string {
  const sortedArgs = JSON.stringify(args, Object.keys(args).sort());
  return shortHash(`${toolName}::${sortedArgs}`);
}

/** Hash tool result content for comparison. */
function resultHash(content: string): string {
  // Normalize: trim, collapse whitespace, truncate to first 2000 chars for perf
  const normalized = content.trim().replace(/\s+/g, ' ').slice(0, 2000);
  return shortHash(normalized);
}

export class GuardrailController {
  private cfg: Required<GuardrailConfig>;
  private toolStats = new Map<string, ToolStats>();
  private noProgressRounds = 0;
  private noProgressWarnEmitted = false;

  // ── NEW: Idempotent no-progress tracking ──
  private noProgressMap = new Map<string, NoProgressRecord>(); // signature → record
  // ── NEW: Global call history for circuit breaker ──
  private callHistory: Array<{ signature: string; resultHash: string }> = [];
  private static readonly HISTORY_SIZE = 40;

  constructor(config?: GuardrailConfig) {
    this.cfg = {
      sameToolFailureWarnAfter: config?.sameToolFailureWarnAfter ?? 3,
      sameToolFailureHaltAfter: config?.sameToolFailureHaltAfter ?? 8,
      noProgressWarnAfter: config?.noProgressWarnAfter ?? 2,
      noProgressHaltAfter: config?.noProgressHaltAfter ?? 5,
      // New config fields with defaults
      idempotentNoProgressWarnAfter: config?.idempotentNoProgressWarnAfter ?? 2,
      idempotentNoProgressHaltAfter: config?.idempotentNoProgressHaltAfter ?? 5,
      globalCircuitBreakerThreshold: config?.globalCircuitBreakerThreshold ?? 15,
    };
  }

  /**
   * Record a tool failure (existing behavior).
   */
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

  /**
   * [NEW] Check BEFORE executing a tool call — can block it if we already know it's futile.
   * Returns "block" if the tool should not be executed.
   */
  beforeToolCall(toolName: string, args: Record<string, unknown>): Decision {
    if (!IDEMPOTENT_TOOLS.has(toolName)) return { action: "continue" };

    const sig = toolSignature(toolName, args);
    const record = this.noProgressMap.get(sig);
    if (!record) return { action: "continue" };

    if (record.repeatCount >= this.cfg.idempotentNoProgressHaltAfter) {
      return {
        action: "block",
        message: `Blocked: "${toolName}" with identical arguments already returned the same result ${record.repeatCount} times. Use the result already available or try a different query/approach.`,
      };
    }
    return { action: "continue" };
  }

  /**
   * [NEW] Record a successful tool call result to detect "no-progress" patterns.
   * Should be called AFTER every successful (non-error) tool execution.
   */
  recordResult(toolName: string, args: Record<string, unknown>, content: string): Decision {
    const sig = toolSignature(toolName, args);
    const rHash = resultHash(content);

    // Track in global history
    this.callHistory.push({ signature: sig, resultHash: rHash });
    if (this.callHistory.length > GuardrailController.HISTORY_SIZE) {
      this.callHistory.shift();
    }

    // ── Global circuit breaker ──
    const globalCount = this.callHistory.filter(
      h => h.signature === sig && h.resultHash === rHash
    ).length;
    if (globalCount >= this.cfg.globalCircuitBreakerThreshold) {
      return {
        action: "halt",
        message: `CIRCUIT BREAKER: Tool "${toolName}" called ${globalCount} times with identical arguments and identical results. Stopping — the tool is not producing useful information.`,
      };
    }

    // ── Idempotent no-progress detection ──
    if (!IDEMPOTENT_TOOLS.has(toolName)) return { action: "continue" };

    const existing = this.noProgressMap.get(sig);
    if (existing && existing.resultHash === rHash) {
      existing.repeatCount++;

      if (existing.repeatCount >= this.cfg.idempotentNoProgressHaltAfter) {
        return {
          action: "halt",
          message: `Tool "${toolName}" returned the same result ${existing.repeatCount} times with identical arguments. Stopping to avoid infinite loop. Use the result already provided or try a completely different approach.`,
        };
      }
      if (existing.repeatCount >= this.cfg.idempotentNoProgressWarnAfter && !existing.warnEmitted) {
        existing.warnEmitted = true;
        return {
          action: "warn",
          message: `Tool "${toolName}" returned the same result ${existing.repeatCount} times. Stop repeating this call — use the result already provided or change the query.`,
        };
      }
    } else {
      // New result or different result — reset or create
      this.noProgressMap.set(sig, { resultHash: rHash, repeatCount: 1, warnEmitted: false });
    }

    return { action: "continue" };
  }

  /**
   * [NEW] Deduplicate tool calls within a single turn.
   * Returns the deduplicated list and a set of blocked call IDs.
   */
  deduplicateToolCalls(toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>): {
    unique: Array<{ id: string; name: string; args: Record<string, unknown> }>;
    blocked: Map<string, string>; // id → reason
  } {
    const unique: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const blocked = new Map<string, string>();
    const seen = new Set<string>();

    for (const tc of toolCalls) {
      const sig = toolSignature(tc.name, tc.args);
      if (seen.has(sig)) {
        blocked.set(tc.id, `Duplicate tool call in same turn: "${tc.name}" with identical arguments — skipped.`);
      } else {
        seen.add(sig);
        unique.push(tc);
      }
    }
    return { unique, blocked };
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
    this.noProgressMap.clear();
    this.callHistory = [];
  }
}
