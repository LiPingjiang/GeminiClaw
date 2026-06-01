/**
 * src/hooks/index.ts
 * Event Hook Bus — 生命周期事件总线
 *
 * 将 AgentLoop 的硬编码 beforeToolCall/afterToolCall 泛化为
 * 可插拔的事件系统，支持 glob 匹配事件名和异步广播。
 *
 * 对齐 Hermes 的 16 个生命周期点（初期实现 9 个核心事件）。
 *
 * 设计原则：
 * - 全异步：所有 handler 返回 Promise
 * - 无阻塞：emit() 并行广播，单个 handler 抛错不影响其他
 * - emitCollect()：收集所有 handler 返回值（用于 pre_* 拦截场景）
 * - glob 匹配：handler 可监听 "pre_*" / "*_call" / "*" 等模式
 * - 类型安全：事件 payload 类型严格定义
 */

// ── Event Types ──────────────────────────────────────────────────────────────

export interface PreToolCallPayload {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  sessionId: string
}

export interface PostToolCallPayload {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  result: { content: string; isError: boolean }
  durationMs: number
  sessionId: string
}

export interface PreLlmCallPayload {
  messageCount: number
  model?: string
  sessionId: string
}

export interface PostLlmCallPayload {
  model?: string
  contentLength: number
  toolCallCount: number
  durationMs: number
  sessionId: string
}

export interface SessionStartPayload {
  sessionId: string
  timestamp: number
}

export interface SessionEndPayload {
  sessionId: string
  totalTurns: number
  stopReason: string
  timestamp: number
}

export interface SessionResetPayload {
  sessionId: string
  timestamp: number
}

export interface SubagentStopPayload {
  agentId: string
  taskId?: string
  reason: string
  sessionId: string
}

export interface PreGatewayDispatchPayload {
  route: string
  providerName: string
  model: string
  sessionId: string
}

// ── Event Map ────────────────────────────────────────────────────────────────

export interface HookEventMap {
  pre_tool_call: PreToolCallPayload
  post_tool_call: PostToolCallPayload
  pre_llm_call: PreLlmCallPayload
  post_llm_call: PostLlmCallPayload
  on_session_start: SessionStartPayload
  on_session_end: SessionEndPayload
  on_session_reset: SessionResetPayload
  subagent_stop: SubagentStopPayload
  pre_gateway_dispatch: PreGatewayDispatchPayload
}

export type HookEventName = keyof HookEventMap

// ── Handler Types ────────────────────────────────────────────────────────────

/**
 * Hook handler function.
 * - For "pre_*" events: return { block: true, reason: "..." } to intercept
 * - For other events: return value is collected by emitCollect()
 */
export type HookHandler<T = unknown> = (payload: T) => Promise<unknown>

interface HandlerEntry {
  pattern: string
  regex: RegExp
  handler: HookHandler<unknown>
  priority: number
  id: string
}

// ── Glob → Regex ─────────────────────────────────────────────────────────────

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`)
}

// ── Hook Bus ─────────────────────────────────────────────────────────────────

let handlerCounter = 0

export class HookBus {
  private handlers: HandlerEntry[] = []

  /**
   * Register a hook handler.
   * @param pattern - Event name or glob pattern (e.g. "pre_*", "*_call", "*")
   * @param handler - Async handler function
   * @param priority - Lower runs first (default 100)
   * @returns Unsubscribe function
   */
  on<K extends HookEventName>(
    pattern: K | string,
    handler: HookHandler<HookEventMap[K]>,
    priority = 100,
  ): () => void {
    const id = `hook_${++handlerCounter}`
    const entry: HandlerEntry = {
      pattern,
      regex: globToRegex(pattern),
      handler: handler as HookHandler<unknown>,
      priority,
      id,
    }
    this.handlers.push(entry)
    // Keep sorted by priority
    this.handlers.sort((a, b) => a.priority - b.priority)

    return () => {
      this.handlers = this.handlers.filter((h) => h.id !== id)
    }
  }

  /**
   * Emit an event — fire-and-forget, handlers run in parallel.
   * Errors are caught and logged, never thrown to caller.
   */
  async emit<K extends HookEventName>(
    event: K,
    payload: HookEventMap[K],
  ): Promise<void> {
    const matching = this.handlers.filter((h) => h.regex.test(event))
    if (matching.length === 0) return

    const results = await Promise.allSettled(
      matching.map((h) => h.handler(payload)),
    )

    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === "rejected") {
        console.error(
          `[HookBus] handler "${matching[i].pattern}" (id=${matching[i].id}) threw on event "${event}":`,
          r.reason,
        )
      }
    }
  }

  /**
   * Emit and collect return values from all matching handlers.
   * Useful for "pre_*" interception where handlers may return
   * { block: true, reason: "..." } to prevent an action.
   *
   * Handlers run sequentially (by priority) so earlier handlers
   * can short-circuit if needed.
   */
  async emitCollect<K extends HookEventName>(
    event: K,
    payload: HookEventMap[K],
  ): Promise<unknown[]> {
    const matching = this.handlers.filter((h) => h.regex.test(event))
    if (matching.length === 0) return []

    const results: unknown[] = []
    for (const h of matching) {
      try {
        const result = await h.handler(payload)
        results.push(result)
      } catch (err) {
        console.error(
          `[HookBus] handler "${h.pattern}" (id=${h.id}) threw on event "${event}":`,
          err,
        )
        results.push(undefined)
      }
    }
    return results
  }

  /**
   * Remove all handlers (useful for testing or session reset).
   */
  clear(): void {
    this.handlers = []
  }

  /**
   * Get count of registered handlers (for diagnostics).
   */
  get size(): number {
    return this.handlers.length
  }

  /**
   * List registered handler patterns (for diagnostics).
   */
  listPatterns(): string[] {
    return this.handlers.map((h) => `${h.pattern} (priority=${h.priority})`)
  }
}

// ── Singleton (global hook bus) ──────────────────────────────────────────────

export const hookBus = new HookBus()
