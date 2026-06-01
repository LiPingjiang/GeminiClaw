/**
 * RunStore — Typed, event-driven store for async run lifecycle.
 *
 * Features:
 * - Typed run states with proper transitions
 * - EventEmitter-based real-time notifications (no polling)
 * - TTL-based auto-cleanup of completed/failed runs
 * - Stream event accumulation for late-joining SSE clients
 */

import { randomUUID } from "crypto"
import { EventEmitter } from "events"

// ── Types ────────────────────────────────────────────────────────────────────

export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled"

export interface RunEvent {
  type: "message_delta" | "tool_call" | "tool_result" | "status_change" | "error" | "done"
  data: unknown
  timestamp: number
}

export interface Run {
  id: string
  status: RunStatus
  sessionId: string
  /** Accumulated response content */
  result?: string
  /** Error message if failed */
  error?: string
  /** All events emitted during this run */
  events: RunEvent[]
  createdAt: number
  updatedAt: number
}

export interface RunStoreConfig {
  /** Max number of completed runs to keep (default: 100) */
  maxCompleted: number
  /** TTL for completed runs in ms (default: 30 minutes) */
  completedTtlMs: number
}

const DEFAULT_RUN_STORE_CONFIG: RunStoreConfig = {
  maxCompleted: 100,
  completedTtlMs: 30 * 60 * 1000,
}

// ── RunStore ─────────────────────────────────────────────────────────────────

export class RunStore {
  private runs = new Map<string, Run>()
  private emitter = new EventEmitter()
  private config: RunStoreConfig
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: Partial<RunStoreConfig>) {
    this.config = { ...DEFAULT_RUN_STORE_CONFIG, ...config }
    this.emitter.setMaxListeners(200) // Allow many concurrent SSE connections

    // Periodic cleanup
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000)
    // Unref so it doesn't keep the process alive
    if (this.cleanupTimer.unref) this.cleanupTimer.unref()
  }

  /**
   * Create a new run. Returns the run ID.
   */
  create(sessionId: string): string {
    const id = `run_${randomUUID().slice(0, 12)}`
    const now = Date.now()
    const run: Run = {
      id,
      status: "pending",
      sessionId,
      events: [],
      createdAt: now,
      updatedAt: now,
    }
    this.runs.set(id, run)
    return id
  }

  /**
   * Get a run by ID.
   */
  get(id: string): Run | undefined {
    return this.runs.get(id)
  }

  /**
   * Transition to running state.
   */
  setRunning(id: string): void {
    const run = this.runs.get(id)
    if (!run || run.status !== "pending") return
    run.status = "running"
    run.updatedAt = Date.now()
    this.pushEvent(id, { type: "status_change", data: { status: "running" }, timestamp: Date.now() })
  }

  /**
   * Append a streaming delta event.
   */
  appendDelta(id: string, delta: string): void {
    const run = this.runs.get(id)
    if (!run || run.status !== "running") return
    run.result = (run.result ?? "") + delta
    run.updatedAt = Date.now()
    this.pushEvent(id, { type: "message_delta", data: { delta }, timestamp: Date.now() })
  }

  /**
   * Record a tool call event.
   */
  appendToolCall(id: string, toolName: string, args: unknown): void {
    const run = this.runs.get(id)
    if (!run || run.status !== "running") return
    run.updatedAt = Date.now()
    this.pushEvent(id, { type: "tool_call", data: { tool: toolName, args }, timestamp: Date.now() })
  }

  /**
   * Record a tool result event.
   */
  appendToolResult(id: string, toolName: string, result: unknown): void {
    const run = this.runs.get(id)
    if (!run || run.status !== "running") return
    run.updatedAt = Date.now()
    this.pushEvent(id, { type: "tool_result", data: { tool: toolName, result }, timestamp: Date.now() })
  }

  /**
   * Mark run as completed.
   */
  complete(id: string, result?: string): void {
    const run = this.runs.get(id)
    if (!run) return
    run.status = "completed"
    if (result !== undefined) run.result = result
    run.updatedAt = Date.now()
    this.pushEvent(id, { type: "done", data: { result: run.result }, timestamp: Date.now() })
  }

  /**
   * Mark run as failed.
   */
  fail(id: string, error: string): void {
    const run = this.runs.get(id)
    if (!run) return
    run.status = "failed"
    run.error = error
    run.updatedAt = Date.now()
    this.pushEvent(id, { type: "error", data: { error }, timestamp: Date.now() })
  }

  /**
   * Cancel a run.
   */
  cancel(id: string): boolean {
    const run = this.runs.get(id)
    if (!run || (run.status !== "pending" && run.status !== "running")) return false
    run.status = "cancelled"
    run.updatedAt = Date.now()
    this.pushEvent(id, { type: "status_change", data: { status: "cancelled" }, timestamp: Date.now() })
    return true
  }

  /**
   * Subscribe to events for a specific run.
   * Returns an unsubscribe function.
   */
  subscribe(id: string, listener: (event: RunEvent) => void): () => void {
    const eventName = `run:${id}`
    this.emitter.on(eventName, listener)
    return () => this.emitter.removeListener(eventName, listener)
  }

  /**
   * Get all active runs.
   */
  getActive(): Run[] {
    return [...this.runs.values()].filter(
      (r) => r.status === "pending" || r.status === "running",
    )
  }

  /**
   * Total runs tracked.
   */
  get size(): number {
    return this.runs.size
  }

  /**
   * Destroy the store and stop cleanup timer.
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.emitter.removeAllListeners()
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private pushEvent(id: string, event: RunEvent): void {
    const run = this.runs.get(id)
    if (run) {
      run.events.push(event)
    }
    this.emitter.emit(`run:${id}`, event)
  }

  private cleanup(): void {
    const now = Date.now()
    const toDelete: string[] = []

    for (const [id, run] of this.runs) {
      if (
        (run.status === "completed" || run.status === "failed" || run.status === "cancelled") &&
        now - run.updatedAt > this.config.completedTtlMs
      ) {
        toDelete.push(id)
      }
    }

    for (const id of toDelete) {
      this.runs.delete(id)
    }

    // Also enforce max completed
    const completed = [...this.runs.values()]
      .filter((r) => r.status === "completed" || r.status === "failed")
      .sort((a, b) => a.updatedAt - b.updatedAt)

    while (completed.length > this.config.maxCompleted) {
      const oldest = completed.shift()!
      this.runs.delete(oldest.id)
    }
  }
}
