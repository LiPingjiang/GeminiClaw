/**
 * Twin-System — Core Types
 *
 * The Twin-System is GeminiClaw's self-evolution mechanism:
 * - Slot A (active): currently running code
 * - Slot B (standby): evolution target for code changes
 * - After validation, slots swap roles
 */

// ── Slot Definition ──────────────────────────────────────────────────────────

export type SlotId = "a" | "b"

export type SlotStatus =
  | "active"      // currently serving requests
  | "standby"     // waiting for next evolution
  | "evolving"    // mutation in progress
  | "validating"  // validation running
  | "failed"      // last evolution failed, needs attention

export interface SlotState {
  id: SlotId
  status: SlotStatus
  /** Git branch name for this slot */
  branch: string
  /** Last successful commit hash */
  lastCommit?: string
  /** Current evolution intent (if evolving) */
  currentIntentId?: string
  /** Timestamp of last status change */
  updatedAt: number
}

// ── Evolution Intent ─────────────────────────────────────────────────────────

export type IntentType = "behavior_fix" | "new_feature" | "upstream_sync" | "optimization"
export type RiskLevel = "low" | "medium" | "high"

export interface EvolutionIntent {
  id: string
  type: IntentType
  description: string
  targetFiles: string[]
  evidence: string[]
  riskLevel: RiskLevel
  requiresHumanApproval: boolean
  createdAt: number
}

// ── Validation Result ────────────────────────────────────────────────────────

export interface ValidationResult {
  level: 1 | 2 | 3
  passed: boolean
  reason?: string
  details: string
  durationMs: number
}

// ── Evolution Record ─────────────────────────────────────────────────────────

export type EvolutionAction = "switch" | "rollback" | "mutation" | "validation"

export interface EvolutionRecord {
  id: string
  intentId: string
  action: EvolutionAction
  success: boolean
  fromSlot: SlotId
  toSlot: SlotId
  changedFiles: string[]
  validationResult?: ValidationResult
  confidence?: { score: number; reason: string; uncertainties: string[] }
  timestamp: number
}

// ── Pipeline Config ──────────────────────────────────────────────────────────

export interface PipelineConfig {
  /** Max mutation rounds */
  maxMutationRounds: number
  /** Confidence threshold to proceed without human review */
  confidenceThreshold: number
  /** Auto-switch when validation passes (vs require manual approval) */
  autoSwitch: boolean
  /** Port for temporary validation process */
  testPort: number
  /** Protected paths that cannot be auto-evolved */
  protectedPaths: string[]
  /** Max evolutions per file in 24 hours */
  maxEvolutionsPerFile24h: number
  /** Monitoring window after switch (ms) */
  postSwitchMonitorMs: number
  /** Failure rate threshold to trigger rollback */
  failureRateThreshold: number
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  maxMutationRounds: 3,
  confidenceThreshold: 0.7,
  autoSwitch: false,
  testPort: 19889,
  protectedPaths: ["src/evolution/", "src/config/", "src/twin-system/", ".gemini-data/"],
  maxEvolutionsPerFile24h: 3,
  postSwitchMonitorMs: 5 * 60 * 1000, // 5 minutes
  failureRateThreshold: 0.1,
}

// ── Pipeline Events ──────────────────────────────────────────────────────────

export type PipelineEvent =
  | { type: "pipeline_started"; intentId: string }
  | { type: "mutation_started"; intentId: string; round: number }
  | { type: "mutation_completed"; intentId: string; success: boolean; changedFiles: string[] }
  | { type: "validation_started"; intentId: string; level: number }
  | { type: "validation_completed"; intentId: string; result: ValidationResult }
  | { type: "switch_requested"; intentId: string; requiresApproval: boolean }
  | { type: "switch_completed"; intentId: string; success: boolean }
  | { type: "rollback_triggered"; intentId: string; reason: string }
  | { type: "pipeline_completed"; intentId: string; success: boolean; summary: string }
