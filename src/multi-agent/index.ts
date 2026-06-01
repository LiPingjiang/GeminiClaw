/**
 * Multi-Agent System — Module exports
 */

export type {
  TaskStatus,
  TaskPriority,
  SubTask,
  TaskResult,
  Artifact,
  ExecutionMetrics,
  IsolationLevel,
  ContextBoundary,
  ExecutionStrategy,
  OrchestrationPlan,
  OrchestrationResult,
  MultiAgentEvent,
} from "./types.js"

export { DEFAULT_BOUNDARY } from "./types.js"

export {
  createBoundary,
  deriveChildBoundary,
  createScopedToolRegistry,
  isPathAllowed,
} from "./context-boundary.js"
export type { BoundaryConfig } from "./context-boundary.js"

export { SubAgentRunner } from "./sub-agent-runner.js"
export type { SubAgentRunnerConfig, RunOptions } from "./sub-agent-runner.js"

export { TaskDelegator } from "./task-delegator.js"
export type { TaskSpec, DelegatorConfig } from "./task-delegator.js"

export { Orchestrator } from "./orchestrator.js"
export type { OrchestratorConfig } from "./orchestrator.js"
