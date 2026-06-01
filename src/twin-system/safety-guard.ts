/**
 * SafetyGuard — Unified safety layer for the evolution engine.
 *
 * Combines:
 * - Protected path enforcement
 * - Evolution frequency limiting (per-file 24h cap)
 * - Circuit breaker state (open = block all evolution)
 * - Risk level gating (high risk = require human approval)
 */

import type {
  EvolutionIntent,
  PipelineConfig,
  RiskLevel,
} from "./types.js"
import { DEFAULT_PIPELINE_CONFIG } from "./types.js"

export interface SafetyDecision {
  allowed: boolean
  reason?: string
  requiresApproval?: boolean
}

export interface EvolutionFrequencyStore {
  /** Get the number of evolutions for a file in the last windowMs */
  getEvolutionCount(file: string, windowMs: number): number
}

export interface SafetyGuardConfig {
  protectedPaths?: string[]
  maxEvolutionsPerFile24h?: number
  failureRateThreshold?: number
}

export class SafetyGuard {
  private config: Pick<
    PipelineConfig,
    "protectedPaths" | "maxEvolutionsPerFile24h" | "failureRateThreshold"
  >
  private circuitOpen = false
  private circuitOpenReason?: string
  private circuitOpenedAt?: number
  private frequencyStore?: EvolutionFrequencyStore

  constructor(
    config: SafetyGuardConfig = {},
    frequencyStore?: EvolutionFrequencyStore,
  ) {
    this.config = {
      protectedPaths:
        config.protectedPaths ?? DEFAULT_PIPELINE_CONFIG.protectedPaths,
      maxEvolutionsPerFile24h:
        config.maxEvolutionsPerFile24h ??
        DEFAULT_PIPELINE_CONFIG.maxEvolutionsPerFile24h,
      failureRateThreshold:
        config.failureRateThreshold ??
        DEFAULT_PIPELINE_CONFIG.failureRateThreshold,
    }
    this.frequencyStore = frequencyStore
  }

  /**
   * Check whether an evolution intent is safe to proceed.
   */
  check(intent: EvolutionIntent): SafetyDecision {
    // 1. Circuit breaker
    if (this.circuitOpen) {
      return {
        allowed: false,
        reason: `Circuit breaker open: ${this.circuitOpenReason ?? "unknown"}`,
      }
    }

    // 2. Protected paths
    for (const file of intent.targetFiles) {
      if (this.isProtected(file)) {
        return {
          allowed: false,
          reason: `Protected path: ${file}`,
        }
      }
    }

    // 3. Frequency limiting
    if (this.frequencyStore) {
      const windowMs = 24 * 60 * 60 * 1000
      for (const file of intent.targetFiles) {
        const count = this.frequencyStore.getEvolutionCount(file, windowMs)
        if (count >= this.config.maxEvolutionsPerFile24h) {
          return {
            allowed: false,
            reason: `Frequency limit: ${file} already evolved ${count}x in 24h (max: ${this.config.maxEvolutionsPerFile24h})`,
          }
        }
      }
    }

    // 4. Risk level gating
    if (intent.riskLevel === "high" || intent.requiresHumanApproval) {
      return {
        allowed: true,
        requiresApproval: true,
        reason: `High-risk intent requires human approval`,
      }
    }

    return { allowed: true }
  }

  /**
   * Open the circuit breaker (blocks all evolution).
   */
  openCircuit(reason: string): void {
    this.circuitOpen = true
    this.circuitOpenReason = reason
    this.circuitOpenedAt = Date.now()
  }

  /**
   * Close the circuit breaker (allow evolution again).
   */
  closeCircuit(): void {
    this.circuitOpen = false
    this.circuitOpenReason = undefined
    this.circuitOpenedAt = undefined
  }

  /** Is the circuit breaker currently open? */
  isCircuitOpen(): boolean {
    return this.circuitOpen
  }

  /** Get circuit breaker state info */
  getCircuitState(): {
    open: boolean
    reason?: string
    openedAt?: number
  } {
    return {
      open: this.circuitOpen,
      reason: this.circuitOpenReason,
      openedAt: this.circuitOpenedAt,
    }
  }

  /**
   * Check if a file path is protected from evolution.
   */
  isProtected(filePath: string): boolean {
    return this.config.protectedPaths.some(
      (pp) => filePath === pp || filePath.startsWith(pp),
    )
  }

  /**
   * Determine required approval level based on risk.
   */
  getApprovalRequirement(intent: EvolutionIntent): "none" | "review" | "manual" {
    if (intent.requiresHumanApproval) return "manual"
    if (intent.riskLevel === "high") return "manual"
    if (intent.riskLevel === "medium") return "review"
    return "none"
  }
}
