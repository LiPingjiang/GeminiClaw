// src/agent/context-window.ts
// Context window monitoring — tracks token usage and triggers compaction.

/** Known context window sizes by model substring. */
const CONTEXT_WINDOWS: Array<[substring: string, tokens: number]> = [
  ['claude-opus-4',    200_000],
  ['claude-sonnet-4',  200_000],
  ['claude-haiku-4',   200_000],
  ['claude-3-7',       200_000],
  ['claude-3-5',       200_000],
  ['claude-3',         200_000],
]
const DEFAULT_CONTEXT_WINDOW = 200_000

/** Tokens reserved for the model's output during a turn. */
const OUTPUT_RESERVE_TOKENS = 8_000

/** Compact when input tokens reach this fraction of the effective window. */
export const COMPACT_TRIGGER_RATIO = 0.78

/** Warn (but don't compact) at this fraction. */
export const WARN_TRIGGER_RATIO = 0.62

export function getContextWindowSize(model?: string): number {
  if (model) {
    for (const [sub, size] of CONTEXT_WINDOWS) {
      if (model.includes(sub)) return size
    }
  }
  return DEFAULT_CONTEXT_WINDOW
}

/** Effective window = total - reserved output tokens. */
export function getEffectiveContextWindow(model?: string): number {
  return getContextWindowSize(model) - OUTPUT_RESERVE_TOKENS
}

/** 0–100 percentage of the effective context window used. */
export function getContextPercent(inputTokens: number, model?: string): number {
  const effective = getEffectiveContextWindow(model)
  return Math.min(100, Math.round((inputTokens / effective) * 100))
}

/** True when compaction should be triggered immediately. */
export function shouldCompact(inputTokens: number, model?: string): boolean {
  const effective = getEffectiveContextWindow(model)
  return inputTokens >= effective * COMPACT_TRIGGER_RATIO
}

/** True when a warning should be logged (below compact threshold). */
export function shouldWarn(inputTokens: number, model?: string): boolean {
  const effective = getEffectiveContextWindow(model)
  const ratio = inputTokens / effective
  return ratio >= WARN_TRIGGER_RATIO && ratio < COMPACT_TRIGGER_RATIO
}

/** Human-readable token count: 1234 → "1.2k", 12345 → "12k". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
