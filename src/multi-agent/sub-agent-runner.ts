/**
 * SubAgentRunner — Spawns and manages an isolated AgentLoop for a sub-task.
 *
 * Responsibilities:
 * - Creates a scoped tool registry respecting the context boundary
 * - Runs AgentLoop with isolated message history
 * - Collects results, metrics, and artifacts
 * - Enforces timeout and turn limits
 * - Emits events for monitoring
 */

import { randomUUID } from "crypto"
import { AgentLoop } from "../agent/loop.js"
import type { ChatFn, InternalMessage } from "../agent/loop.js"
import type {
  SubTask,
  TaskResult,
  Artifact,
  ExecutionMetrics,
  ContextBoundary,
  MultiAgentEvent,
} from "./types.js"
import { createScopedToolRegistry } from "./context-boundary.js"
import type { ToolRegistryLike } from "../agent/loop.js"

export interface SubAgentRunnerConfig {
  chatFn: ChatFn
  toolRegistry: ToolRegistryLike
  boundary: ContextBoundary
  /** System prompt for the sub-agent */
  systemPrompt?: string
  /** Timeout in ms (0 = no timeout) */
  timeoutMs?: number
  /** Logger */
  logger?: {
    info(msg: string, ...args: unknown[]): void
    warn(msg: string, ...args: unknown[]): void
    error(msg: string, ...args: unknown[]): void
  }
}

export interface RunOptions {
  /** Additional context to prepend to the task description */
  parentContext?: string
  /** Pre-existing messages to seed the sub-agent's history */
  seedMessages?: InternalMessage[]
  /** AbortSignal for external cancellation */
  signal?: AbortSignal
}

export class SubAgentRunner {
  private config: SubAgentRunnerConfig
  private events: MultiAgentEvent[] = []

  constructor(config: SubAgentRunnerConfig) {
    this.config = config
  }

  /**
   * Execute a sub-task. Returns the TaskResult when done.
   */
  async run(task: SubTask, options: RunOptions = {}): Promise<TaskResult> {
    const agentId = `sub_${randomUUID().slice(0, 8)}`
    const startMs = Date.now()
    let turnsUsed = 0
    let toolCallCount = 0
    const artifacts: Artifact[] = []

    this.emit({ type: "agent_spawned", agentId, taskId: task.id })
    this.emit({ type: "task_started", taskId: task.id, agentId })

    // Build scoped tool registry
    const scopedRegistry = createScopedToolRegistry(
      this.config.toolRegistry,
      this.config.boundary,
    )

    // Build initial messages
    const messages = this.buildMessages(task, options)

    // Create the agent loop
    const loop = new AgentLoop({
      chatFn: this.config.chatFn,
      toolRegistry: scopedRegistry,
      config: {
        maxTurns: task.maxTurns,
        systemPrompt: this.config.systemPrompt ?? this.buildSystemPrompt(task),
        toolExecutionMode: "parallel",
        maxToolOutputChars: 8000,
      },
      logger: this.config.logger
        ? { debug: this.config.logger.info.bind(this.config.logger), error: this.config.logger.error.bind(this.config.logger) }
        : { debug: () => {}, error: () => {} },
    })

    // Setup timeout
    const abortController = new AbortController()
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeoutMs = this.config.timeoutMs ?? 0

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs)
    }

    // Merge signals
    const signal = options.signal
      ? this.mergeSignals(options.signal, abortController.signal)
      : abortController.signal

    try {
      let finalOutput = ""
      let loopErrored = false

      const iterator = loop.run({
        messages,
        sessionId: `sub_session_${task.id}`,
        signal,
      })

      for await (const event of iterator) {
        switch (event.type) {
          case "turn_start":
            turnsUsed++
            break
          case "turn_end":
            toolCallCount += (event as { toolCallCount?: number }).toolCallCount ?? 0
            break
          case "message_delta":
            finalOutput += (event as { delta: string }).delta
            break
          case "tool_end": {
            const toolEvent = event as {
              toolName: string
              result: { content: string; isError: boolean }
            }
            // Track file writes as artifacts
            if (
              toolEvent.toolName === "write" &&
              !toolEvent.result.isError
            ) {
              artifacts.push({
                type: "file",
                content: toolEvent.result.content,
              })
            }
            break
          }
          case "agent_end": {
            const endEvent = event as { stopReason?: string }
            if (endEvent.stopReason === "error") loopErrored = true
            break
          }
        }
      }

      const metrics: ExecutionMetrics = {
        turnsUsed,
        toolCallCount,
        durationMs: Date.now() - startMs,
      }

      if (loopErrored) {
        const failResult: TaskResult = {
          success: false,
          output: finalOutput || "Task failed: sub-agent LLM call errored",
          artifacts,
          metrics,
        }
        this.emit({
          type: "task_failed",
          taskId: task.id,
          error: "sub-agent LLM call errored",
        })
        this.emit({ type: "agent_terminated", agentId, reason: "error" })
        return failResult
      }

      const result: TaskResult = {
        success: true,
        output: finalOutput,
        artifacts,
        metrics,
      }

      this.emit({ type: "task_completed", taskId: task.id, result })
      this.emit({
        type: "agent_terminated",
        agentId,
        reason: "task_complete",
      })

      return result
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      const metrics: ExecutionMetrics = {
        turnsUsed,
        toolCallCount,
        durationMs: Date.now() - startMs,
      }

      const result: TaskResult = {
        success: false,
        output: `Task failed: ${errorMsg}`,
        artifacts,
        metrics,
      }

      this.emit({ type: "task_failed", taskId: task.id, error: errorMsg })
      this.emit({ type: "agent_terminated", agentId, reason: "error" })

      return result
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  /** Get all events emitted during execution */
  getEvents(): MultiAgentEvent[] {
    return [...this.events]
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private buildMessages(
    task: SubTask,
    options: RunOptions,
  ): InternalMessage[] {
    const messages: InternalMessage[] = []

    // Seed messages (parent context)
    if (options.seedMessages) {
      messages.push(...options.seedMessages)
    }

    // Build task instruction as user message
    let instruction = `## Task: ${task.title}\n\n${task.description}`
    if (options.parentContext) {
      instruction = `## Context from parent agent:\n${options.parentContext}\n\n${instruction}`
    }

    messages.push({ role: "user", content: instruction })
    return messages
  }

  private buildSystemPrompt(task: SubTask): string {
    return [
      "You are a focused sub-agent working on a specific task.",
      `Your task: "${task.title}"`,
      "",
      "Guidelines:",
      "- Focus exclusively on the assigned task",
      "- Be concise and efficient in your tool usage",
      "- Report results clearly when done",
      "- Do not attempt tasks outside your scope",
      "",
      task.allowedTools.length > 0
        ? `Available tools: ${task.allowedTools.join(", ")}`
        : "You have access to the standard tool set.",
    ].join("\n")
  }

  private emit(event: MultiAgentEvent): void {
    this.events.push(event)
    this.config.logger?.info(
      `[SubAgent] ${event.type}: ${JSON.stringify(event)}`,
    )
  }

  private mergeSignals(...signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController()
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason)
        return controller.signal
      }
      signal.addEventListener("abort", () => controller.abort(signal.reason), {
        once: true,
      })
    }
    return controller.signal
  }
}
