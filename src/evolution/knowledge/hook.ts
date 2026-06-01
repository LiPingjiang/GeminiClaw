/**
 * src/evolution/knowledge/hook.ts
 * Registers knowledge evolution hooks on the HookBus.
 *
 * Strategy:
 *  - on_session_end: trigger BackgroundReviewer (async, non-blocking)
 *  - Curator runs on a timer or can be triggered manually
 */

import { hookBus } from "../../hooks/index.js"
import { BackgroundReviewer, type TurnContext, type ChatFunction } from "./background-review.js"
import { KnowledgeStore } from "./store.js"
import { Curator } from "./curator.js"
import type { SessionEndPayload, PostLlmCallPayload } from "../../hooks/index.js"

// ── Accumulator for turn context ─────────────────────────────────────────────

interface TurnAccumulator {
  userMessage: string
  assistantResponse: string
  toolCalls: Array<{ name: string; result: string }>
  turnIndex: number
}

// Per-session accumulators
const sessionTurns = new Map<string, TurnAccumulator[]>()

// ── Options ──────────────────────────────────────────────────────────────────

export interface KnowledgeHookOptions {
  /** LLM chat function for reviewer/curator */
  chatFn: ChatFunction
  /** Disable knowledge evolution hooks */
  disabled?: boolean
  /** Reviewer config overrides */
  reviewerConfig?: {
    minConfidence?: number
    maxItemsPerTurn?: number
    cooldownMs?: number
  }
  /** Curator config overrides */
  curatorConfig?: {
    intervalMs?: number
    minClusterSize?: number
  }
}

// ── Registration ─────────────────────────────────────────────────────────────

export interface KnowledgeHookContext {
  store: KnowledgeStore
  reviewer: BackgroundReviewer
  curator: Curator
  unsubscribe: () => void
}

/**
 * Register knowledge evolution hooks on the global HookBus.
 * Returns context objects for external access and unsubscribe.
 */
export function registerKnowledgeHooks(options: KnowledgeHookOptions): KnowledgeHookContext {
  const store = new KnowledgeStore()
  const reviewer = new BackgroundReviewer({
    store,
    chatFn: options.chatFn,
    config: {
      enabled: !options.disabled,
      ...options.reviewerConfig,
    },
  })
  const curator = new Curator({
    store,
    chatFn: options.chatFn,
    config: {
      enabled: !options.disabled,
      ...options.curatorConfig,
    },
  })

  const unsubs: Array<() => void> = []

  if (options.disabled) {
    return { store, reviewer, curator, unsubscribe: () => {} }
  }

  // ── Track turns for review context ───────────────────────────────────────

  // Capture post_llm_call to track assistant responses per session
  const unsubLlm = hookBus.on(
    "post_llm_call",
    async (payload: PostLlmCallPayload) => {
      // We track sessions for turn accumulation
      // Note: actual message content is not in post_llm_call payload
      // Turn context is built via on_session_end with accumulated data
      return undefined
    },
    200, // Low priority, just tracking
  )
  unsubs.push(unsubLlm)

  // ── on_session_end: run background review ────────────────────────────────

  const unsubSessionEnd = hookBus.on(
    "on_session_end",
    async (payload: SessionEndPayload) => {
      const turns = sessionTurns.get(payload.sessionId) ?? []
      if (turns.length === 0) return

      // Review the last turn (most recent context)
      const lastTurn = turns[turns.length - 1]
      const turnContext: TurnContext = {
        sessionId: payload.sessionId,
        turnIndex: lastTurn.turnIndex,
        userMessage: lastTurn.userMessage,
        assistantResponse: lastTurn.assistantResponse,
        toolCalls: lastTurn.toolCalls,
      }

      // Fire-and-forget background review
      reviewer.review(turnContext).catch((err) => {
        console.error("[KnowledgeHook] Background review failed:", err)
      })

      // Cleanup session accumulator
      sessionTurns.delete(payload.sessionId)

      // Check if curator is due
      if (curator.isDue()) {
        curator.run(false).catch((err) => {
          console.error("[KnowledgeHook] Curator run failed:", err)
        })
      }
    },
    150, // After main processing
  )
  unsubs.push(unsubSessionEnd)

  const unsubscribe = () => {
    for (const unsub of unsubs) unsub()
    sessionTurns.clear()
  }

  return { store, reviewer, curator, unsubscribe }
}

/**
 * Record a turn's context for later review.
 * Called by the chat handler when a turn completes.
 */
export function recordTurn(
  sessionId: string,
  turn: TurnAccumulator,
): void {
  const turns = sessionTurns.get(sessionId) ?? []
  turns.push(turn)
  sessionTurns.set(sessionId, turns)
}
