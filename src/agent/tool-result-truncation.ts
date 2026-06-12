// src/agent/tool-result-truncation.ts
/**
 * Smart tool result truncation — 3-layer defense against context explosion.
 *
 * Layer 1: Per-result smart truncation (head+tail preserving errors)
 * Layer 2: Large result persistence to file (preview only in context)
 * Layer 3: Per-turn aggregate budget enforcement
 *
 * Inspired by OpenClaw's head+tail truncation and Hermes's 3-layer
 * tool_result_storage + budget_config system.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import os from "os";

// ── Layer 1 thresholds ──────────────────────────────────────────────────────
const MAX_RESULT_CHARS = 12_000;
const HEAD_CHARS = 4_000;
const TAIL_CHARS = 3_000;

// ── Layer 2 thresholds ──────────────────────────────────────────────────────
const PERSIST_THRESHOLD = 50_000;
const PREVIEW_CHARS = 2_000;

// ── Layer 3 thresholds ──────────────────────────────────────────────────────
const TURN_BUDGET_CHARS = 80_000;

// ── Tools that must never be persisted (prevents read→persist→read loop) ────
const NEVER_PERSIST = new Set(["read", "read_file", "file_read"]);

// ── Result dir ──────────────────────────────────────────────────────────────
const RESULTS_BASE_DIR = join(os.tmpdir(), "geminiclaw-results");

export interface TruncationResult {
  content: string;
  persisted?: string;
  originalLength: number;
  wasTruncated: boolean;
}

/**
 * Detect whether the tail of a text contains important information
 * (errors, JSON closing, summaries) that should be preserved.
 */
function hasImportantTail(text: string): boolean {
  const tail = text.slice(-2000).toLowerCase();
  return (
    /\b(error|exception|failed|fatal|traceback|panic|exit code|errno|stack trace)\b/.test(tail) ||
    /\}\s*$/.test(tail.trim()) ||
    /\b(total|summary|result|complete|finished|done|success)\b/.test(tail)
  );
}

/**
 * Layer 1: Smart truncation with head+tail preservation.
 */
function smartTruncate(content: string): string {
  if (content.length <= MAX_RESULT_CHARS) return content;

  if (hasImportantTail(content)) {
    const head = content.slice(0, HEAD_CHARS);
    const tail = content.slice(-TAIL_CHARS);
    const omitted = content.length - HEAD_CHARS - TAIL_CHARS;
    return `${head}\n\n⚠️ [... ${omitted} chars omitted — showing head and tail ...]\n\n${tail}`;
  }

  // Simple head truncation for content without important tail
  return (
    content.slice(0, MAX_RESULT_CHARS) +
    `\n...[truncated ${content.length - MAX_RESULT_CHARS} chars]`
  );
}

/**
 * Layer 2: Persist large results to file, return preview.
 */
function maybePersist(
  content: string,
  toolName: string,
  sessionId: string,
): TruncationResult {
  if (content.length < PERSIST_THRESHOLD || NEVER_PERSIST.has(toolName)) {
    const truncated = smartTruncate(content);
    return {
      content: truncated,
      originalLength: content.length,
      wasTruncated: truncated.length < content.length,
    };
  }

  // Persist to temp file
  const sessionDir = join(RESULTS_BASE_DIR, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const fileName = `${toolName}-${randomUUID().slice(0, 8)}.txt`;
  const filePath = join(sessionDir, fileName);
  writeFileSync(filePath, content, "utf-8");

  const preview = content.slice(0, PREVIEW_CHARS);
  const summary =
    `${preview}\n\n` +
    `📁 [Full output (${content.length} chars) saved to: ${filePath}]\n` +
    `Use the \`read\` tool with this path to access the full content if needed.`;

  return {
    content: summary,
    persisted: filePath,
    originalLength: content.length,
    wasTruncated: true,
  };
}

/**
 * Main entry: truncate a single tool result (Layer 1 + Layer 2).
 */
export function truncateToolResult(
  content: string,
  toolName: string,
  sessionId: string = "default",
): TruncationResult {
  return maybePersist(content, toolName, sessionId);
}

/**
 * Layer 3: Enforce per-turn aggregate budget.
 * If total content exceeds TURN_BUDGET_CHARS, persist the largest results
 * until we're back under budget.
 */
export function enforceTurnBudget(
  results: TruncationResult[],
  sessionId: string = "default",
): TruncationResult[] {
  const totalChars = results.reduce((sum, r) => sum + r.content.length, 0);
  if (totalChars <= TURN_BUDGET_CHARS) return results;

  // Sort by content length descending (we'll persist the biggest first)
  const indexed = results.map((r, i) => ({ r, i, len: r.content.length }));
  indexed.sort((a, b) => b.len - a.len);

  let currentTotal = totalChars;
  const updated = [...results];

  for (const item of indexed) {
    if (currentTotal <= TURN_BUDGET_CHARS) break;
    if (item.r.persisted) continue; // already persisted

    // Persist this result
    const sessionDir = join(RESULTS_BASE_DIR, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const fileName = `budget-overflow-${randomUUID().slice(0, 8)}.txt`;
    const filePath = join(sessionDir, fileName);
    writeFileSync(filePath, item.r.content, "utf-8");

    const preview = item.r.content.slice(0, PREVIEW_CHARS);
    const newContent =
      `${preview}\n\n` +
      `📁 [Budget overflow: full output (${item.r.content.length} chars) saved to: ${filePath}]`;

    const savings = item.r.content.length - newContent.length;
    currentTotal -= savings;

    updated[item.i] = {
      content: newContent,
      persisted: filePath,
      originalLength: item.r.originalLength,
      wasTruncated: true,
    };
  }

  return updated;
}
