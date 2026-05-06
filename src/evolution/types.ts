// src/evolution/types.ts
// Shared types for the Evolution Engine (Phase A)

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

export type IntentType =
  | "behavior_fix"
  | "new_feature"
  | "upstream_sync"
  | "performance"
  | "bootstrap"

export type IntentStatus =
  | "pending"
  | "in_progress"
  | "validating"
  | "approved"
  | "rejected"
  | "applied"
  | "rolled_back"
  | "snoozed"

export type RiskLevel = "low" | "medium" | "high"

export interface Intent {
  id: string
  type: IntentType
  description: string
  targetFiles: string[]  // JSON array in DB
  evidence: string[]     // JSON array in DB
  riskLevel: RiskLevel
  requiresHumanApproval: boolean
  status: IntentStatus
  whyNow: string
  discoveredContext: string
  snoozedUntil?: number   // Unix timestamp ms
  snoozeCount: number
  createdAt: number       // Unix timestamp ms
  updatedAt: number       // Unix timestamp ms
}

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

export interface TraceRecord {
  id: string
  sessionId: string
  toolSequence: string[]  // JSON array in DB
  hadFailure: boolean
  messageCount: number
  responseLength: number  // actual response character count, for Level 2 length check
  recordedAt: number      // Unix timestamp ms
}

// ---------------------------------------------------------------------------
// Evolution History
// ---------------------------------------------------------------------------

export interface EvolutionRecord {
  id?: number             // AUTOINCREMENT, optional on insert
  intentId: string
  type: "switch" | "rollback"
  fromSlot: string
  toSlot: string
  changedFiles: string[]  // JSON array in DB
  recordedAt: number      // Unix timestamp ms
}

// ---------------------------------------------------------------------------
// Slot
// ---------------------------------------------------------------------------

export type SlotId = "a" | "b"
export type SlotRole = "active" | "standby"

export interface SlotState {
  slotId: SlotId
  role: SlotRole
  buildHash: string
  builtAt: number         // Unix timestamp ms
  lastActivatedAt?: number // Unix timestamp ms
}

// ---------------------------------------------------------------------------
// Upstream Check
// ---------------------------------------------------------------------------

export interface UpstreamCheck {
  id?: number             // AUTOINCREMENT, optional on insert
  newCommits: string[]    // JSON array
  changedFiles: string[]  // JSON array
  addedLines: number
  removedLines: number
  checkedAt: number       // Unix timestamp ms
  intentGenerated: boolean
}

// ---------------------------------------------------------------------------
// Pending Review
// ---------------------------------------------------------------------------

export interface PendingReview {
  intentId: string
  description: string
  targetFiles: string[]   // JSON array
  riskLevel: RiskLevel
  status: "pending" | "approved" | "rejected"
  reviewer?: string
  comment?: string
  requestedAt: number     // Unix timestamp ms
  resolvedAt?: number     // Unix timestamp ms
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationLevel = 1 | 2 | 3

export interface ValidationResultStaticCheck {
  buildPassed: boolean
  testsPassed: boolean
  lintPassed: boolean
}

export interface ValidationResultBehaviorCheck {
  tracesUsed: number
  errorRate: number
  lengthCheckPassRate: number
  toolSequenceMatchRate: number
}

export interface ValidationResult {
  level: ValidationLevel
  passed: boolean
  skipped?: boolean
  reason?: string
  staticCheck?: ValidationResultStaticCheck
  behaviorCheck?: ValidationResultBehaviorCheck
  details: string
  durationMs: number
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

export interface MutationConfidence {
  score: number           // 0-1
  reason: string
  uncertainties: string[]
}

export interface MutationResult {
  success: boolean
  changedFiles: string[]
  confidence: MutationConfidence
  error?: string
  rounds: number          // how many agentic loop rounds were used
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export interface SwitchResult {
  success: boolean
  fromSlot: SlotId
  toSlot: SlotId
  intentId?: string
  error?: string
}

// ---------------------------------------------------------------------------
// CircuitBreaker State
// ---------------------------------------------------------------------------

export interface CircuitBreakerState {
  isOpen: boolean
  openedAt?: number
  openReason?: string
  monitoringIntentId?: string
}

// ---------------------------------------------------------------------------
// Evolution Config
// ---------------------------------------------------------------------------

export interface EvolutionConfig {
  enabled: boolean
  dataDir: string
  validator: {
    level: ValidationLevel
    standbyPort: number
    testPort: number        // port for Level 2 temporary process
    diffThreshold: number  // 0-1, max allowed diff ratio
  }
  mutator: {
    maxRounds: number
    confidenceThreshold: number  // 0-1, below this → escalate risk
  }
  circuitBreaker: {
    errorRateThreshold: number   // 0-1
    responseTimeMultiplier: number  // e.g. 2.0 = 2x baseline
    maxEvolutionsPerFile24h: number
    failureThreshold: number    // 0-1, failure rate to trigger rollback
    monitoringWindowMs: number  // ms to monitor after switch
    checkIntervalMs: number     // ms between health checks
  }
  background: {
    idleThresholdMs: number      // ms of inactivity before pushing notifications
  }
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  enabled: true,
  dataDir: ".gemini-data",
  validator: {
    level: 1,
    standbyPort: 18889,
    testPort: 19889,
    diffThreshold: 0.3,
  },
  mutator: {
    maxRounds: 3,
    confidenceThreshold: 0.7,
  },
  circuitBreaker: {
    errorRateThreshold: 0.2,
    responseTimeMultiplier: 2.0,
    maxEvolutionsPerFile24h: 3,
    failureThreshold: 0.5,
    monitoringWindowMs: 10 * 60 * 1000,  // 10 minutes
    checkIntervalMs: 30 * 1000,           // 30 seconds
  },
  background: {
    idleThresholdMs: 5 * 60 * 1000,  // 5 minutes
  },
}

// ---------------------------------------------------------------------------
// Engine Status & RunOnce
// ---------------------------------------------------------------------------

export interface EvolutionStatus {
  enabled: boolean
  activeSlot: SlotId
  standbySlot: SlotId
  pendingIntents: number
  lastEvolution?: EvolutionRecord
  lastUpstreamCheck?: UpstreamCheck
  traceCount: number
}

export interface RunOnceResult {
  intentId?: string
  mutationResult?: MutationResult
  validationResults: ValidationResult[]
  switchResult?: SwitchResult
  skipped: boolean
  skipReason?: string
}
