/**
 * Multi-Agent System — Core Types
 *
 * Defines the type contracts for task delegation, context boundaries,
 * and orchestration across multiple agent instances.
 */

// ── Context Mode ─────────────────────────────────────────────────────────────

/**
 * Controls how much parent context a sub-agent inherits.
 *
 * - isolated: (default) No parent context. Sub-agent gets only skills + task description.
 *   Best for independent tasks that don't need conversation history.
 *
 * - fork: Full context inheritance. Sub-agent gets compressed parent conversation
 *   summary + per-agent memory + skills. Like OpenClaw's fork mode.
 *   Best for tasks that need to understand the ongoing conversation.
 *
 * - lightweight: Minimal bootstrap. No skills injection, just task + basic tools.
 *   Best for simple tool-calling tasks (e.g. "fetch this URL", "read this file").
 *   Saves ~80% of system prompt tokens.
 */
export type ContextMode = "isolated" | "fork" | "lightweight"

// ── Token Budget ─────────────────────────────────────────────────────────────

/**
 * Token threshold for automatic degradation.
 * When system prompt exceeds this, auto-degrade from fork → isolated → lightweight.
 * Based on OpenClaw's 100K threshold pattern.
 */
export const TOKEN_THRESHOLD = {
  /** Above this, fork mode degrades to isolated (drop parent context) */
  FORK_TO_ISOLATED: 100_000,
  /** Above this, isolated degrades to lightweight (drop skills) */
  ISOLATED_TO_LIGHTWEIGHT: 150_000,
  /** Absolute maximum — refuse to spawn if exceeded */
  ABSOLUTE_MAX: 180_000,
} as const

// ── Task Definition ──────────────────────────────────────────────────────────

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

export type TaskPriority = "low" | "normal" | "high" | "critical"

export interface SubTask {
  id: string
  title: string
  description: string
  priority: TaskPriority
  status: TaskStatus
  /** Parent task ID (null for root) */
  parentId: string | null
  /** Agent ID assigned to execute this task */
  assignedAgentId?: string
  /** Tool whitelist for this task (empty = inherit from parent) */
  allowedTools: string[]
  /** Maximum turns the sub-agent can use */
  maxTurns: number
  /** Files/directories the sub-agent can access */
  allowedPaths: string[]
  /** Task dependencies: must complete before this task starts */
  dependsOn: string[]
  /** Context propagation mode (isolated/fork/lightweight) */
  contextMode: ContextMode
  /** Results produced upon completion */
  result?: TaskResult
  /** Creation timestamp */
  createdAt: number
  /** Last status update timestamp */
  updatedAt: number
}

export interface TaskResult {
  success: boolean
  output: string
  /** Structured result parsed from the sub-agent's three-part output */
  structured?: StructuredResult
  /** Artifacts produced (file paths, data, etc.) */
  artifacts: Artifact[]
  /** Metrics about the execution */
  metrics: ExecutionMetrics
}

/**
 * Three-part structured result from sub-agent output.
 * Inspired by smolagents' conclusion/details/context pattern.
 */
export interface StructuredResult {
  /** One-line conclusion (success/failure/partial) */
  conclusion: string
  /** Detailed execution output */
  details: string
  /** Additional context useful for follow-up tasks (optional) */
  additionalContext?: string
}

export interface Artifact {
  type: "file" | "data" | "message"
  path?: string
  content?: string
  metadata?: Record<string, unknown>
}

export interface ExecutionMetrics {
  turnsUsed: number
  toolCallCount: number
  durationMs: number
  tokensUsed?: { input: number; output: number }
}

// ── Context Boundary ─────────────────────────────────────────────────────────

export type IsolationLevel = "strict" | "shared_read" | "full_access"

export interface ContextBoundary {
  /** How much of parent context is shared */
  isolationLevel: IsolationLevel
  /** Tools the sub-agent can use */
  allowedTools: string[]
  /** Tools explicitly denied */
  deniedTools: string[]
  /** File paths accessible to the sub-agent */
  allowedPaths: string[]
  /** Environment variables to pass through */
  envPassthrough: string[]
  /** Maximum depth of sub-agent spawning */
  maxDepth: number
  /** Maximum concurrent sub-agents */
  maxConcurrent: number
  /** Whether the sub-agent can spawn its own sub-agents */
  canDelegate: boolean
}

export const DEFAULT_BOUNDARY: ContextBoundary = {
  isolationLevel: "shared_read",
  allowedTools: [], // empty = all tools allowed
  deniedTools: ["create_agent"], // sub-agents can't create more agents by default
  allowedPaths: [],
  envPassthrough: ["PATH", "HOME", "NODE_ENV"],
  maxDepth: 3,
  maxConcurrent: 4,
  canDelegate: true,
}

// ── Orchestration ────────────────────────────────────────────────────────────

export type ExecutionStrategy = "parallel" | "sequential" | "dependency_graph"

export interface OrchestrationPlan {
  id: string
  strategy: ExecutionStrategy
  tasks: SubTask[]
  /** Global boundary for all tasks (individual tasks can override) */
  boundary: ContextBoundary
  /** Maximum total execution time (ms) */
  timeoutMs: number
  /** Abort remaining tasks on first failure */
  failFast: boolean
  /** Created timestamp */
  createdAt: number
}

export interface OrchestrationResult {
  planId: string
  status: "completed" | "partial" | "failed"
  tasks: SubTask[]
  /** Summary of all results */
  summary: string
  metrics: {
    totalDurationMs: number
    tasksCompleted: number
    tasksFailed: number
    tasksCancelled: number
  }
}

// ── Events ───────────────────────────────────────────────────────────────────

export type MultiAgentEvent =
  | { type: "task_started"; taskId: string; agentId: string }
  | { type: "task_completed"; taskId: string; result: TaskResult }
  | { type: "task_failed"; taskId: string; error: string }
  | { type: "task_cancelled"; taskId: string; reason: string }
  | { type: "agent_spawned"; agentId: string; taskId: string }
  | { type: "agent_terminated"; agentId: string; reason: string }
  | { type: "orchestration_complete"; result: OrchestrationResult }
