/**
 * EvolutionEngine — the common abstraction shared by GeminiClaw's two
 * independent self-evolution engines.
 *
 * GeminiClaw runs TWO evolution engines that are completely independent and can
 * be toggled separately (both on, just one, or none):
 *
 *   1. CODE engine  (twin-system): mutates the agent's own *source code* on a
 *      git branch, validates (build + tests), and squash-merges to main. High
 *      power, high risk. Default OFF.
 *
 *   2. SKILL engine (skill-evolution): the Hermes-style paradigm. Instead of
 *      touching code, it reflects on real conversations and crystallises /
 *      refines *skill files* (Markdown SKILL.md under ~/.geminiclaw/skills/).
 *      Low risk, no compilation, "the more it's used the sharper it gets."
 *
 * Both engines:
 *   - are driven by the same kind of trigger (idle / cron / manual),
 *   - read the same conversation history as their evidence source,
 *   - expose a uniform status snapshot,
 *   - can be started/stopped on their own.
 *
 * This module is the seam that lets index.ts treat them uniformly while keeping
 * their implementations entirely separate.
 */

export type EvolutionEngineKind = "code" | "skill"

export type EvolutionTrigger = "idle" | "cron" | "manual"

/** Uniform status snapshot every engine must be able to report. */
export interface EvolutionEngineStatus {
  kind: EvolutionEngineKind
  enabled: boolean
  /** Whether the engine's scheduler is currently running. */
  running: boolean
  /** Total cycles attempted since process start. */
  totalCycles: number
  successCount: number
  failureCount: number
  /** Engine-specific extra fields (e.g. skillsCreated, branchSwitches). */
  extra?: Record<string, unknown>
}

/** Result of running a single evolution cycle. */
export interface EvolutionCycleResult {
  kind: EvolutionEngineKind
  /** Did the cycle produce a landed, accepted change? */
  success: boolean
  /** Why the cycle ended without a landed change (if !success). */
  reason?: string
  /** Human-readable summary of what happened. */
  summary: string
  /** Engine-specific payload (changedFiles for code, skillName/action for skill). */
  details?: Record<string, unknown>
  durationMs: number
}

/**
 * The contract both engines implement. Deliberately minimal so the two
 * implementations stay decoupled — the orchestrator only needs these.
 */
export interface EvolutionEngine {
  readonly kind: EvolutionEngineKind
  /** Whether this engine is enabled by config. */
  readonly enabled: boolean

  /** Start the engine's own scheduler (idle/cron). No-op if disabled. */
  start(): void
  /** Stop the engine's scheduler and release resources. */
  stop(): void

  /**
   * Run exactly one evolution cycle on demand (manual trigger / API).
   * Engines should run a cycle even when their scheduler is stopped, so the
   * manual API works for verification regardless of enabled state.
   */
  runOnce(trigger?: EvolutionTrigger): Promise<EvolutionCycleResult>

  /** Current status snapshot. */
  status(): EvolutionEngineStatus
}
