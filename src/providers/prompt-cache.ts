/**
 * src/providers/prompt-cache.ts
 * Anthropic Prompt Caching — marks breakpoints in the message array so the
 * Anthropic API can cache and reuse prefixes across calls.
 *
 * Strategy: "system_and_3"
 *   - system prompt → ephemeral cache breakpoint
 *   - last 3 user/assistant messages → ephemeral cache breakpoints
 *
 * This is a pure function with no side effects. It mutates nothing; returns a
 * new system string and new messages array with cache_control annotations.
 *
 * References:
 *   https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */

import type Anthropic from "@anthropic-ai/sdk"

// Minimum token count for a block to be worth caching (Anthropic requirement: 1024 for haiku, 2048 for others)
// We use a conservative char-based heuristic: 4 chars ≈ 1 token
const MIN_CACHEABLE_CHARS = 4096 // ~1024 tokens

export interface CacheControlBlock {
  type: "ephemeral"
}

/**
 * Apply cache_control breakpoints to the Anthropic system parameter.
 * Returns system as an array of content blocks with cache_control on the last block.
 */
export function applyCacheToSystem(
  system: string | undefined,
): Anthropic.MessageCreateParams["system"] | undefined {
  if (!system || system.length < MIN_CACHEABLE_CHARS) {
    return system
  }

  return [
    {
      type: "text" as const,
      text: system,
      cache_control: { type: "ephemeral" } as CacheControlBlock,
    },
  ]
}

/**
 * Apply cache_control breakpoints to the last N messages in the array.
 * Modifies a COPY of the messages — does not mutate input.
 *
 * Strategy: mark the last `count` messages that have cacheable content.
 * We only mark messages with sufficient length to benefit from caching.
 */
export function applyCacheToMessages(
  messages: Anthropic.MessageParam[],
  count: number = 3,
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages

  // Deep clone to avoid mutating original
  const result: Anthropic.MessageParam[] = JSON.parse(JSON.stringify(messages))

  // Walk from the end, mark up to `count` messages
  let marked = 0
  for (let i = result.length - 1; i >= 0 && marked < count; i--) {
    const msg = result[i]
    const content = msg.content

    if (typeof content === "string") {
      if (content.length >= MIN_CACHEABLE_CHARS) {
        // Convert to block format to attach cache_control
        msg.content = [
          {
            type: "text" as const,
            text: content,
            cache_control: { type: "ephemeral" } as CacheControlBlock,
          },
        ]
        marked++
      }
    } else if (Array.isArray(content) && content.length > 0) {
      // Mark the last block in this message's content array
      const lastBlock = content[content.length - 1]
      if (lastBlock && typeof lastBlock === "object") {
        ;(lastBlock as unknown as Record<string, unknown>).cache_control = { type: "ephemeral" }
        marked++
      }
    }
  }

  return result
}

/**
 * Convenience: apply caching to both system and messages in one call.
 * This is the main entry point used by the Anthropic provider.
 */
export function applyPromptCache(params: {
  system?: string
  messages: Anthropic.MessageParam[]
  breakpoints?: number
}): {
  system: Anthropic.MessageCreateParams["system"] | undefined
  messages: Anthropic.MessageParam[]
} {
  return {
    system: applyCacheToSystem(params.system),
    messages: applyCacheToMessages(params.messages, params.breakpoints ?? 3),
  }
}
