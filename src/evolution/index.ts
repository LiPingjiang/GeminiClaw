// src/evolution/index.ts
// EvolutionEngine — Phase C implementation.

import { mkdirSync } from "fs"
import { join } from "path"
import { EvolutionDB } from "./db.js"
import { TraceCollector } from "./trace/collector.js"
import { Mutator } from "./mutator/mutator.js"
import { Validator } from "./validator/validator.js"
import { Switcher } from "./switcher/switcher.js"
import { CircuitBreaker } from "./circuit-breaker/circuit-breaker.js"
import {
  DEFAULT_EVOLUTION_CONFIG,
  type EvolutionConfig,
  type EvolutionRecord,
  type EvolutionStatus,
  type Intent,
  type RunOnceResult,
  type SlotId,
  type SwitchResult,
  type ValidationResult,
} from "./types.js"
import type { ProviderRouter } from "../providers/router.js"

// ---------------------------------------------------------------------------
// Logger interface (minimal, no external dependency)
// ---------------------------------------------------------------------------

export interface Logger {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

const defaultLogger: Logger = {
  info: (msg, ...args) => console.log(`[EvolutionEngine] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[EvolutionEngine] WARN ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[EvolutionEngine] ERROR ${msg}`, ...args),
}

// ---------------------------------------------------------------------------
// EvolutionEngine
// ---------------------------------------------------------------------------

export interface EvolutionEngineParams {
  db: EvolutionDB
  providerRouter: ProviderRouter
  repoRoot: string
  config?: Partial<EvolutionConfig>
  logger?: Logger
}

export class EvolutionEngine {
  private db: EvolutionDB
  private providerRouter: ProviderRouter
  private repoRoot: string
  private config: EvolutionConfig
  private logger: Logger
  private traceCollector: TraceCollector
  private mutator: Mutator
  private validator: Validator
  private switcher: Switcher
  private circuitBreaker: CircuitBreaker
  private running = false

  constructor(params: EvolutionEngineParams) {
    this.db = params.db
    this.providerRouter = params.providerRouter
    this.repoRoot = params.repoRoot
    this.logger = params.logger ?? defaultLogger
    this.config = {
      ...DEFAULT_EVOLUTION_CONFIG,
      ...params.config,
      validator: {
        ...DEFAULT_EVOLUTION_CONFIG.validator,
        ...(params.config?.validator ?? {}),
      },
      mutator: {
        ...DEFAULT_EVOLUTION_CONFIG.mutator,
        ...(params.config?.mutator ?? {}),
      },
      circuitBreaker: {
        ...DEFAULT_EVOLUTION_CONFIG.circuitBreaker,
        ...(params.config?.circuitBreaker ?? {}),
      },
      background: {
        ...DEFAULT_EVOLUTION_CONFIG.background,
        ...(params.config?.background ?? {}),
      },
    }
    this.traceCollector = new TraceCollector(this.db)
    this.mutator = new Mutator({
      providerRouter: this.providerRouter,
      repoRoot: this.repoRoot,
      config: this.config.mutator,
      logger: this.logger,
    })
    this.validator = new Validator({
      repoRoot: this.repoRoot,
      config: this.config.validator,
      logger: this.logger,
      db: this.db,
    })
    this.switcher = new Switcher({
      repoRoot: this.repoRoot,
      db: this.db,
      logger: this.logger,
    })
    this.circuitBreaker = new CircuitBreaker({
      db: this.db,
      switcher: this.switcher,
      config: this.config.circuitBreaker,
      logger: this.logger,
    })
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize DB tables and seed slot_state if not already present.
   * Called once at startup from src/index.ts.
   */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    // Ensure data directory exists
    const dataDir = join(this.repoRoot, this.config.dataDir)
    mkdirSync(dataDir, { recursive: true })

    // Seed slot_state with initial values if the table is empty
    const slotA = this.db.getSlotState("a")
    if (!slotA) {
      this.db.upsertSlotState({
        slotId: "a",
        role: "active",
        buildHash: "",
        builtAt: 0,
        lastActivatedAt: Date.now(),
      })
    }
    const slotB = this.db.getSlotState("b")
    if (!slotB) {
      this.db.upsertSlotState({
        slotId: "b",
        role: "standby",
        buildHash: "",
        builtAt: 0,
      })
    }

    this.logger.info("started (dataDir=%s)", dataDir)
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.circuitBreaker.stopMonitoring()
    this.logger.info("stopped")
  }

  // -------------------------------------------------------------------------
  // TraceCollector accessor (used by chat route)
  // -------------------------------------------------------------------------

  getTraceCollector(): TraceCollector {
    return this.traceCollector
  }

  // -------------------------------------------------------------------------
  // Phase C: Core evolution cycle with CircuitBreaker + Level 2
  // -------------------------------------------------------------------------

  /**
   * Run one full evolution cycle:
   *   1. CircuitBreaker.canEvolve() check
   *   2. Pick the first pending intent from DB
   *   3. Create evolution branch
   *   4. Mutator.mutate()
   *   5. If lowConfidence, escalate riskLevel
   *   6. Validator.validate() — Level 1
   *   7. If Level 1 passed and traces sufficient, run Level 2
   *   8. If both pass and riskLevel=low → auto switch + start CircuitBreaker monitoring
   *   9. If riskLevel=medium/high → return { needsApproval: true }
   *  10. Update intent status
   */
  async runOnce(): Promise<RunOnceResult> {
    const pendingIntents = this.db.listIntents({ status: "pending" })
    if (pendingIntents.length === 0) {
      return {
        validationResults: [],
        skipped: true,
        skipReason: "no pending intents",
      }
    }

    const intent = pendingIntents[0]
    this.logger.info("Processing intent %s: %s", intent.id, intent.description)

    // Step 1: CircuitBreaker check
    const cbCheck = this.circuitBreaker.canEvolve(intent.targetFiles)
    if (!cbCheck.allowed) {
      this.logger.warn(
        "Evolution blocked by CircuitBreaker for intent %s: %s",
        intent.id,
        cbCheck.reason
      )
      return {
        intentId: intent.id,
        validationResults: [],
        skipped: true,
        skipReason: `CircuitBreaker blocked: ${cbCheck.reason}`,
      }
    }

    // Mark in-progress
    this.db.updateIntentStatus(intent.id, "in_progress")

    let branchName: string
    try {
      branchName = this.switcher.createEvolutionBranch(intent.id)
    } catch (err) {
      const error = (err as Error).message
      this.logger.error("Failed to create evolution branch: %s", error)
      this.db.updateIntentStatus(intent.id, "rejected")
      return {
        intentId: intent.id,
        validationResults: [],
        skipped: false,
        skipReason: `Failed to create branch: ${error}`,
      }
    }

    // Mutate
    const mutationResult = await this.mutator.mutate(intent)

    if (!mutationResult.success) {
      this.logger.warn("Mutation failed for intent %s: %s", intent.id, mutationResult.error)
      this.db.updateIntentStatus(intent.id, "rejected")
      return {
        intentId: intent.id,
        mutationResult,
        validationResults: [],
        skipped: false,
        skipReason: `Mutation failed: ${mutationResult.error}`,
      }
    }

    // Check confidence — escalate risk if below threshold
    let effectiveIntent: Intent = intent
    if (
      mutationResult.confidence.score < this.config.mutator.confidenceThreshold
    ) {
      this.logger.warn(
        "Low confidence (%.2f < %.2f) for intent %s — escalating risk level",
        mutationResult.confidence.score,
        this.config.mutator.confidenceThreshold,
        intent.id
      )
      effectiveIntent = this.escalateRisk(intent)
    }

    // Validate (Level 1)
    this.db.updateIntentStatus(intent.id, "validating")
    const level1Result = await this.validator.validate(effectiveIntent)
    const validationResults: ValidationResult[] = [level1Result]

    if (!level1Result.passed) {
      this.logger.warn("Level 1 validation failed for intent %s", intent.id)
      this.db.updateIntentStatus(intent.id, "rejected")
      return {
        intentId: intent.id,
        mutationResult,
        validationResults,
        skipped: false,
      }
    }

    // Level 2 validation (if traces are sufficient)
    const traceCount = this.db.countTraces()
    if (traceCount >= 3) {
      this.logger.info("Running Level 2 validation for intent %s", intent.id)
      const level2Result = await this.validator.validateLevel2(effectiveIntent)
      validationResults.push(level2Result)

      if (!level2Result.passed && !level2Result.skipped) {
        this.logger.warn("Level 2 validation failed for intent %s: %s", intent.id, level2Result.reason)
        this.db.updateIntentStatus(intent.id, "rejected")
        return {
          intentId: intent.id,
          mutationResult,
          validationResults,
          skipped: false,
        }
      }
    } else {
      this.logger.info(
        "Skipping Level 2 validation for intent %s: insufficient traces (%d < 3)",
        intent.id,
        traceCount
      )
    }

    // Decide whether to auto-switch or require approval
    if (effectiveIntent.riskLevel === "low" && !effectiveIntent.requiresHumanApproval) {
      // Auto switch
      this.logger.info("Auto-switching for low-risk intent %s", intent.id)
      const switchResult = await this.switcher.switch(branchName, effectiveIntent)

      if (switchResult.success) {
        this.db.updateIntentStatus(intent.id, "applied")
        // Start CircuitBreaker monitoring after successful switch
        this.circuitBreaker.startMonitoring(intent.id)
      } else {
        this.db.updateIntentStatus(intent.id, "rejected")
      }

      return {
        intentId: intent.id,
        mutationResult,
        validationResults,
        switchResult,
        skipped: false,
      }
    } else {
      // Needs approval
      this.logger.info(
        "Intent %s requires approval (riskLevel=%s, requiresHumanApproval=%s)",
        intent.id,
        effectiveIntent.riskLevel,
        effectiveIntent.requiresHumanApproval
      )
      this.db.updateIntentStatus(intent.id, "approved")  // awaiting manual switch

      // Add to pending reviews
      this.db.insertPendingReview({
        intentId: intent.id,
        description: effectiveIntent.description,
        targetFiles: effectiveIntent.targetFiles,
        riskLevel: effectiveIntent.riskLevel,
        status: "pending",
        requestedAt: Date.now(),
      })

      return {
        intentId: intent.id,
        mutationResult,
        validationResults,
        skipped: false,
        skipReason: `Needs approval (riskLevel=${effectiveIntent.riskLevel})`,
      }
    }
  }

  /**
   * Manually trigger a slot switch (for medium/high-risk intents waiting on human).
   * Finds the current evolution branch and switches to main.
   */
  async manualSwitch(): Promise<SwitchResult> {
    const currentBranch = this.switcher.getCurrentBranch()

    if (!currentBranch.startsWith("evolution/")) {
      // Not on an evolution branch — look for approved intents
      const approvedIntents = this.db.listIntents({ status: "approved" })
      if (approvedIntents.length === 0) {
        return {
          success: false,
          fromSlot: "b",
          toSlot: "a",
          error: "No approved intents found and not on an evolution branch",
        }
      }

      const intent = approvedIntents[0]
      const branchName = `evolution/${intent.id}`
      const result = await this.switcher.switch(branchName, intent)
      if (result.success) {
        this.circuitBreaker.startMonitoring(intent.id)
      }
      return result
    }

    // Currently on an evolution branch — find the intent
    const intentId = currentBranch.replace("evolution/", "")
    const intent = this.db.getIntent(intentId)

    if (!intent) {
      return {
        success: false,
        fromSlot: "b",
        toSlot: "a",
        error: `No intent found for branch ${currentBranch}`,
      }
    }

    const result = await this.switcher.switch(currentBranch, intent)
    if (result.success) {
      this.circuitBreaker.startMonitoring(intentId)
    }
    return result
  }

  /**
   * Approve a high-risk intent that is waiting for human review.
   */
  async approveIntent(intentId: string, reviewer: string): Promise<void> {
    const review = this.db.getPendingReview(intentId)
    if (!review) {
      throw new Error(`No pending review found for intent ${intentId}`)
    }
    this.db.updatePendingReview(intentId, {
      status: "approved",
      reviewer,
      resolvedAt: Date.now(),
    })
    this.db.updateIntentStatus(intentId, "approved")
    this.logger.info("intent %s approved by %s", intentId, reviewer)
  }

  /**
   * Get current engine status.
   */
  async getStatus(): Promise<EvolutionStatus> {
    const slotA = this.db.getSlotState("a")
    const slotB = this.db.getSlotState("b")

    const activeSlot: SlotId = slotA?.role === "active" ? "a" : "b"
    const standbySlot: SlotId = activeSlot === "a" ? "b" : "a"

    const pendingIntents = this.db.listIntents({ status: "pending" })
    const lastEvolution = this.db.getLastEvolutionRecord()
    const lastUpstreamCheck = this.db.getLastUpstreamCheck()
    const traceCount = this.db.countTraces()

    void slotB  // referenced above, suppress unused warning

    return {
      enabled: this.config.enabled,
      activeSlot,
      standbySlot,
      pendingIntents: pendingIntents.length,
      lastEvolution: lastEvolution ?? undefined,
      lastUpstreamCheck: lastUpstreamCheck ?? undefined,
      traceCount,
    }
  }

  /**
   * Get evolution history.
   */
  async getHistory(limit = 20): Promise<EvolutionRecord[]> {
    return this.db.listEvolutionHistory(limit)
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** @internal */
  getDb(): EvolutionDB {
    return this.db
  }

  /** @internal */
  getConfig(): EvolutionConfig {
    return this.config
  }

  /** @internal */
  getProviderRouter(): ProviderRouter {
    return this.providerRouter
  }

  /** @internal */
  getRepoRoot(): string {
    return this.repoRoot
  }

  /** @internal */
  getMutator(): Mutator {
    return this.mutator
  }

  /** @internal */
  getValidator(): Validator {
    return this.validator
  }

  /** @internal */
  getSwitcher(): Switcher {
    return this.switcher
  }

  /** @internal */
  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker
  }

  private escalateRisk(intent: Intent): Intent {
    const nextRisk: Record<string, Intent["riskLevel"]> = {
      low: "medium",
      medium: "high",
      high: "high",
    }
    return {
      ...intent,
      riskLevel: nextRisk[intent.riskLevel] ?? "high",
      requiresHumanApproval: true,
    }
  }
}

// Re-export for convenience
export { EvolutionDB } from "./db.js"
export { TraceCollector } from "./trace/collector.js"
export { Mutator } from "./mutator/mutator.js"
export { Validator } from "./validator/validator.js"
export { Switcher } from "./switcher/switcher.js"
export { CircuitBreaker } from "./circuit-breaker/circuit-breaker.js"
export * from "./types.js"
