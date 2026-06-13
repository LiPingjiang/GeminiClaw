// src/multi-agent/mailbox.ts
/**
 * Agent Mailbox — Inter-Agent Communication Protocol
 *
 * Provides a simple message-passing interface between named agents:
 * - sendTask(): Agent A sends a task to Agent B (by name)
 * - reportResult(): Agent B reports completion back to A
 * - onTaskResult(): Agent A subscribes to results addressed to it
 *
 * Design:
 * - Process-internal (no network), based on callbacks
 * - Messages are fire-and-forget from sender's perspective
 * - Results are delivered asynchronously via registered handlers
 * - Integrates with LifecycleBus for execution lifecycle
 */

import { randomUUID } from "crypto"

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TaskMessage {
  /** Unique message ID */
  id: string
  /** Sender agent name or ID */
  from: string
  /** Target agent name (resolved to template at execution time) */
  to: string
  /** Task description */
  task: string
  /** Optional context/data to pass */
  context?: string
  /** Message status */
  status: "pending" | "executing" | "completed" | "failed"
  /** Creation timestamp */
  createdAt: number
}

export interface TaskResultReport {
  /** Original message ID */
  messageId: string
  /** Who completed it */
  from: string
  /** Success or failure */
  success: boolean
  /** Result output */
  output: string
  /** Duration in ms */
  durationMs?: number
}

export interface SendTaskParams {
  from: string
  to: string
  task: string
  context?: string
}

// ── State ──────────────────────────────────────────────────────────────────────

/** All pending/active messages */
const messages = new Map<string, TaskMessage>()

/** Result handlers: agentId/name → callback */
type ResultHandler = (result: TaskResultReport) => void
const resultHandlers = new Map<string, Set<ResultHandler>>()

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Send a task from one agent to another. Returns the message immediately.
 * Actual execution is triggered separately by the executor.
 */
export function sendTask(params: SendTaskParams): TaskMessage {
  const msg: TaskMessage = {
    id: `msg_${randomUUID().slice(0, 12)}`,
    from: params.from,
    to: params.to,
    task: params.task,
    context: params.context,
    status: "pending",
    createdAt: Date.now(),
  }
  messages.set(msg.id, msg)
  return msg
}

/**
 * Report a task result back to the sender. Triggers registered handlers.
 */
export function reportResult(
  messageId: string,
  result: Omit<TaskResultReport, "messageId" | "from">,
): void {
  const msg = messages.get(messageId)
  if (!msg) {
    console.warn(`[Mailbox] reportResult: unknown messageId=${messageId}`)
    return
  }

  msg.status = result.success ? "completed" : "failed"

  const report: TaskResultReport = {
    messageId,
    from: msg.to,
    ...result,
  }

  // Notify the sender's handlers
  const handlers = resultHandlers.get(msg.from)
  if (handlers) {
    for (const fn of handlers) {
      try {
        fn(report)
      } catch (err) {
        console.error("[Mailbox] result handler threw:", err)
      }
    }
  }
}

/**
 * Subscribe to task results addressed to a specific agent.
 * Returns unsubscribe function.
 */
export function onTaskResult(agentId: string, handler: ResultHandler): () => void {
  if (!resultHandlers.has(agentId)) {
    resultHandlers.set(agentId, new Set())
  }
  resultHandlers.get(agentId)!.add(handler)
  return () => {
    resultHandlers.get(agentId)?.delete(handler)
  }
}

/**
 * Get a message by ID (for status checking).
 */
export function getMessage(id: string): TaskMessage | undefined {
  return messages.get(id)
}

/**
 * Mark a message as executing.
 */
export function markExecuting(messageId: string): void {
  const msg = messages.get(messageId)
  if (msg) msg.status = "executing"
}

/**
 * Get all pending messages for a target agent.
 */
export function getPendingForAgent(targetName: string): TaskMessage[] {
  const result: TaskMessage[] = []
  for (const msg of messages.values()) {
    if (msg.to === targetName && msg.status === "pending") {
      result.push(msg)
    }
  }
  return result
}

/** Test helper */
export function __resetMailbox(): void {
  messages.clear()
  resultHandlers.clear()
}
