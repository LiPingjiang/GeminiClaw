/**
 * Twin-System — Self-Evolution Engine
 *
 * Exports:
 * - SlotManager: dual-slot lifecycle management
 * - SafetyGuard: circuit breaker + protected paths + frequency limits
 * - EvolutionPipeline: orchestrator for intent→mutate→validate→switch
 * - Types: all type definitions
 */

export { SlotManager } from "./slot-manager.js"
export type { GitOps, SlotManagerConfig } from "./slot-manager.js"

export { SafetyGuard } from "./safety-guard.js"
export type { SafetyDecision, EvolutionFrequencyStore, SafetyGuardConfig } from "./safety-guard.js"

export { EvolutionPipeline } from "./evolution-pipeline.js"
export type {
  MutationResult,
  Mutator,
  Validator,
  EvolutionPipelineConfig,
  PipelineResult,
} from "./evolution-pipeline.js"

export type {
  SlotId,
  SlotStatus,
  SlotState,
  IntentType,
  RiskLevel,
  EvolutionIntent,
  ValidationResult,
  EvolutionAction,
  EvolutionRecord,
  PipelineConfig,
  PipelineEvent,
} from "./types.js"
export { DEFAULT_PIPELINE_CONFIG } from "./types.js"
