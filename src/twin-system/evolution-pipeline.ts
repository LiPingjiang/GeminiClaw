/**
 * EvolutionPipeline — Orchestrates the full evolution cycle.
 *
 * Flow:
 * 1. Safety check (guard)
 * 2. Begin evolution (slot manager creates branch)
 * 3. Mutation (LLM generates code changes)
 * 4. Validation (build + test)
 * 5. Switch decision (auto or manual)
 * 6. Post-switch monitoring
 *
 * This is the typed, production-grade replacement for the @ts-nocheck
 * ritual-handler that previously existed.
 */

import type {
  EvolutionIntent,
  PipelineConfig,
  PipelineEvent,
  ValidationResult,
  EvolutionRecord,
} from "./types.js"
import { DEFAULT_PIPELINE_CONFIG } from "./types.js"
import type { SlotManager } from "./slot-manager.js"
import type { SafetyGuard } from "./safety-guard.js"

// ── Mutation Interface ───────────────────────────────────────────────────────

export interface MutationResult {
  success: boolean
  changedFiles: string[]
  confidence: { score: number; reason: string; uncertainties: string[] }
  rounds: number
  error?: string
}

export interface Mutator {
  mutate(intent: EvolutionIntent): Promise<MutationResult>
}

// ── Validator Interface ──────────────────────────────────────────────────────

export interface Validator {
  validate(intent: EvolutionIntent): Promise<ValidationResult>
  validateLevel2?(intent: EvolutionIntent): Promise<ValidationResult>
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

export interface EvolutionPipelineConfig {
  slotManager: SlotManager
  safetyGuard: SafetyGuard
  mutator: Mutator
  validator: Validator
  config?: Partial<PipelineConfig>
  logger?: {
    info(msg: string, ...args: unknown[]): void
    warn(msg: string, ...args: unknown[]): void
    error(msg: string, ...args: unknown[]): void
  }
  /** Called when human approval is needed. Returns true if approved. */
  onApprovalNeeded?: (intent: EvolutionIntent, summary: string) => Promise<boolean>
}

export interface PipelineResult {
  success: boolean
  intentId: string
  mutationResult?: MutationResult
  validationResult?: ValidationResult
  switchRecord?: EvolutionRecord
  abortReason?: string
  events: PipelineEvent[]
}

export class EvolutionPipeline {
  private slotManager: SlotManager
  private safetyGuard: SafetyGuard
  private mutator: Mutator
  private validator: Validator
  private config: PipelineConfig
  private logger: NonNullable<EvolutionPipelineConfig["logger"]>
  private onApprovalNeeded?: EvolutionPipelineConfig["onApprovalNeeded"]
  private events: PipelineEvent[] = []

  constructor(params: EvolutionPipelineConfig) {
    this.slotManager = params.slotManager
    this.safetyGuard = params.safetyGuard
    this.mutator = params.mutator
    this.validator = params.validator
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...params.config }
    this.logger = params.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    }
    this.onApprovalNeeded = params.onApprovalNeeded
  }

  /**
   * Execute the full evolution pipeline for an intent.
   */
  async run(intent: EvolutionIntent): Promise<PipelineResult> {
    this.events = []
    this.emit({ type: "pipeline_started", intentId: intent.id })

    // ── Step 1: Safety Check ──────────────────────────────────────────────
    const safety = this.safetyGuard.check(intent)
    if (!safety.allowed) {
      this.log(`Pipeline blocked: ${safety.reason}`)
      return this.abort(intent.id, `Safety check failed: ${safety.reason}`)
    }

    if (safety.requiresApproval && this.onApprovalNeeded) {
      const approved = await this.onApprovalNeeded(
        intent,
        `Intent "${intent.description}" requires approval (${safety.reason})`,
      )
      if (!approved) {
        return this.abort(intent.id, "Human approval denied")
      }
    }

    // ── Step 2: Begin Evolution ───────────────────────────────────────────
    if (!this.slotManager.isStandbyAvailable()) {
      return this.abort(intent.id, "Standby slot not available")
    }

    let branchName: string
    try {
      branchName = this.slotManager.beginEvolution(intent)
      this.log(`Evolution started on branch: ${branchName}`)
    } catch (err) {
      return this.abort(
        intent.id,
        `Failed to begin evolution: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // ── Step 3: Mutation ──────────────────────────────────────────────────
    this.emit({ type: "mutation_started", intentId: intent.id, round: 1 })
    let mutationResult: MutationResult

    try {
      mutationResult = await this.mutator.mutate(intent)
    } catch (err) {
      this.slotManager.markFailed(intent.id)
      return this.abort(
        intent.id,
        `Mutation threw: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    this.emit({
      type: "mutation_completed",
      intentId: intent.id,
      success: mutationResult.success,
      changedFiles: mutationResult.changedFiles,
    })

    if (!mutationResult.success) {
      this.slotManager.markFailed(intent.id)
      return this.abort(
        intent.id,
        `Mutation failed: ${mutationResult.error ?? "unknown"}`,
        mutationResult,
      )
    }

    // ── Step 4: Validation ────────────────────────────────────────────────
    this.slotManager.markValidating(intent.id)
    this.emit({ type: "validation_started", intentId: intent.id, level: 1 })

    let validationResult: ValidationResult
    try {
      validationResult = await this.validator.validate(intent)
    } catch (err) {
      this.slotManager.markFailed(intent.id)
      return this.abort(
        intent.id,
        `Validation threw: ${err instanceof Error ? err.message : String(err)}`,
        mutationResult,
      )
    }

    this.emit({
      type: "validation_completed",
      intentId: intent.id,
      result: validationResult,
    })

    if (!validationResult.passed) {
      this.slotManager.markFailed(intent.id)
      return this.abort(
        intent.id,
        `Validation failed: ${validationResult.reason ?? "unknown"}`,
        mutationResult,
        validationResult,
      )
    }

    // ── Step 5: Switch Decision ───────────────────────────────────────────
    const needsApproval =
      !this.config.autoSwitch ||
      mutationResult.confidence.score < this.config.confidenceThreshold ||
      intent.riskLevel === "high"

    this.emit({
      type: "switch_requested",
      intentId: intent.id,
      requiresApproval: needsApproval,
    })

    if (needsApproval && this.onApprovalNeeded) {
      const summary = [
        `Intent: ${intent.description}`,
        `Changed files: ${mutationResult.changedFiles.join(", ")}`,
        `Confidence: ${mutationResult.confidence.score.toFixed(2)}`,
        `Validation: Level ${validationResult.level} passed`,
      ].join("\n")

      const approved = await this.onApprovalNeeded(intent, summary)
      if (!approved) {
        this.slotManager.abortEvolution()
        return this.abort(
          intent.id,
          "Switch approval denied",
          mutationResult,
          validationResult,
        )
      }
    }

    // ── Step 6: Execute Switch ────────────────────────────────────────────
    let switchRecord: EvolutionRecord
    try {
      switchRecord = this.slotManager.executeSwitch(intent)
    } catch (err) {
      this.slotManager.abortEvolution()
      return this.abort(
        intent.id,
        `Switch failed: ${err instanceof Error ? err.message : String(err)}`,
        mutationResult,
        validationResult,
      )
    }

    this.emit({
      type: "switch_completed",
      intentId: intent.id,
      success: true,
    })

    const summary = [
      `Evolution "${intent.description}" completed successfully.`,
      `Changed ${mutationResult.changedFiles.length} files in ${mutationResult.rounds} round(s).`,
      `Confidence: ${mutationResult.confidence.score.toFixed(2)}`,
    ].join(" ")

    this.emit({
      type: "pipeline_completed",
      intentId: intent.id,
      success: true,
      summary,
    })

    return {
      success: true,
      intentId: intent.id,
      mutationResult,
      validationResult,
      switchRecord,
      events: [...this.events],
    }
  }

  /** Get all events from the last run */
  getEvents(): PipelineEvent[] {
    return [...this.events]
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private abort(
    intentId: string,
    reason: string,
    mutationResult?: MutationResult,
    validationResult?: ValidationResult,
  ): PipelineResult {
    this.emit({
      type: "pipeline_completed",
      intentId,
      success: false,
      summary: reason,
    })

    return {
      success: false,
      intentId,
      mutationResult,
      validationResult,
      abortReason: reason,
      events: [...this.events],
    }
  }

  private emit(event: PipelineEvent): void {
    this.events.push(event)
    this.logger.info(`[Pipeline] ${event.type}: ${JSON.stringify(event)}`)
  }

  private log(msg: string): void {
    this.logger.info(`[Pipeline] ${msg}`)
  }
}
