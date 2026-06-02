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

export { UpstreamTracker, DEFAULT_TRACKER_CONFIG } from "./upstream-tracker.js"
export type {
  UpstreamRepo,
  UpstreamGitOps,
  DiffAnalyzer,
  DiffAnalysisResult,
  UpstreamTrackerConfig,
  TrackerCheckResult,
  TrackerStats,
} from "./upstream-tracker.js"

export { TraceIntentSource, MemoryIntentSource, UpstreamIntentSource } from "./intent-sources.js"
export type { TraceIntentSourceConfig, MemoryIntentSourceConfig } from "./intent-sources.js"

export { EvolutionMetrics, DEFAULT_METRICS_CONFIG } from "./metrics.js"
export type { CycleRecord, MetricsSnapshot, MetricsConfig } from "./metrics.js"

export { ApprovalGate, DEFAULT_APPROVAL_CONFIG } from "./approval-gate.js"
export type { ApprovalRequest, ApprovalGateConfig } from "./approval-gate.js"
