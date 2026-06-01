// @ts-nocheck — test file; Anthropic SDK internal type strictness not relevant here
/**
 * Tests for src/providers/prompt-cache.ts
 */
import { describe, it, expect } from "vitest"
import { applyCacheToSystem, applyCacheToMessages, applyPromptCache } from "./prompt-cache.js"

describe("prompt-cache", () => {
  describe("applyCacheToSystem", () => {
    it("returns undefined for undefined input", () => {
      expect(applyCacheToSystem(undefined)).toBeUndefined()
    })

    it("returns plain string for short system prompts (below threshold)", () => {
      const short = "You are a helpful assistant."
      expect(applyCacheToSystem(short)).toBe(short)
    })

    it("returns array with cache_control for long system prompts", () => {
      const long = "x".repeat(5000) // > 4096 chars threshold
      const result = applyCacheToSystem(long)
      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(1)
      const block = (result as unknown[])[0] as Record<string, unknown>
      expect(block.type).toBe("text")
      expect(block.text).toBe(long)
      expect(block.cache_control).toEqual({ type: "ephemeral" })
    })

    it("caches system prompts exactly at threshold (>= semantics)", () => {
      const exact = "x".repeat(4096)
      const result = applyCacheToSystem(exact)
      expect(Array.isArray(result)).toBe(true)
    })

    it("does not cache system prompts just below threshold", () => {
      const below = "x".repeat(4095)
      expect(applyCacheToSystem(below)).toBe(below)
    })
  })

  describe("applyCacheToMessages", () => {
    it("returns empty array unchanged", () => {
      expect(applyCacheToMessages([])).toEqual([])
    })

    it("marks the last N messages with array content", () => {
      const messages = [
        { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] },
        { role: "assistant" as const, content: [{ type: "text" as const, text: "hi there" }] },
        { role: "user" as const, content: [{ type: "text" as const, text: "what?" }] },
      ]

      const result = applyCacheToMessages(messages, 2)

      // Last 2 should have cache_control on their last content block
      const last = result[2].content as Array<Record<string, unknown>>
      expect(last[0].cache_control).toEqual({ type: "ephemeral" })

      const secondLast = result[1].content as Array<Record<string, unknown>>
      expect(secondLast[0].cache_control).toEqual({ type: "ephemeral" })

      // First should NOT have cache_control
      const first = result[0].content as Array<Record<string, unknown>>
      expect(first[0].cache_control).toBeUndefined()
    })

    it("marks string content only if above threshold", () => {
      const messages = [
        { role: "user" as const, content: "short msg" },
        { role: "assistant" as const, content: "a".repeat(5000) }, // above threshold
      ]

      const result = applyCacheToMessages(messages, 2)

      // Long message should be converted to array with cache_control
      expect(Array.isArray(result[1].content)).toBe(true)
      const block = (result[1].content as Array<Record<string, unknown>>)[0]
      expect(block.cache_control).toEqual({ type: "ephemeral" })

      // Short message stays as string (not worth caching)
      expect(result[0].content).toBe("short msg")
    })

    it("does not mutate the original messages array", () => {
      const messages = [
        { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] },
      ]
      const original = JSON.parse(JSON.stringify(messages))

      applyCacheToMessages(messages, 1)

      expect(messages).toEqual(original)
    })

    it("handles count larger than message array length", () => {
      const messages = [
        { role: "user" as const, content: [{ type: "text" as const, text: "only one" }] },
      ]

      const result = applyCacheToMessages(messages, 5)

      const block = (result[0].content as Array<Record<string, unknown>>)[0]
      expect(block.cache_control).toEqual({ type: "ephemeral" })
    })
  })

  describe("applyPromptCache", () => {
    it("applies both system and message caching", () => {
      const system = "y".repeat(5000)
      const messages = [
        { role: "user" as const, content: [{ type: "text" as const, text: "test" }] },
      ]

      const result = applyPromptCache({ system, messages })

      // System should be cached
      expect(Array.isArray(result.system)).toBe(true)

      // Messages should have cache_control
      const block = (result.messages[0].content as Array<Record<string, unknown>>)[0]
      expect(block.cache_control).toEqual({ type: "ephemeral" })
    })

    it("uses default breakpoints=3", () => {
      const messages = [
        { role: "user" as const, content: [{ type: "text" as const, text: "1" }] },
        { role: "assistant" as const, content: [{ type: "text" as const, text: "2" }] },
        { role: "user" as const, content: [{ type: "text" as const, text: "3" }] },
        { role: "assistant" as const, content: [{ type: "text" as const, text: "4" }] },
      ]

      const result = applyPromptCache({ messages })

      // Last 3 should be marked
      const msg4 = (result.messages[3].content as Array<Record<string, unknown>>)[0]
      const msg3 = (result.messages[2].content as Array<Record<string, unknown>>)[0]
      const msg2 = (result.messages[1].content as Array<Record<string, unknown>>)[0]
      const msg1 = (result.messages[0].content as Array<Record<string, unknown>>)[0]

      expect(msg4.cache_control).toEqual({ type: "ephemeral" })
      expect(msg3.cache_control).toEqual({ type: "ephemeral" })
      expect(msg2.cache_control).toEqual({ type: "ephemeral" })
      expect(msg1.cache_control).toBeUndefined()
    })

    it("respects custom breakpoints count", () => {
      const messages = [
        { role: "user" as const, content: [{ type: "text" as const, text: "1" }] },
        { role: "assistant" as const, content: [{ type: "text" as const, text: "2" }] },
        { role: "user" as const, content: [{ type: "text" as const, text: "3" }] },
      ]

      const result = applyPromptCache({ messages, breakpoints: 1 })

      // Only the last message should be marked
      const last = (result.messages[2].content as Array<Record<string, unknown>>)[0]
      const second = (result.messages[1].content as Array<Record<string, unknown>>)[0]

      expect(last.cache_control).toEqual({ type: "ephemeral" })
      expect(second.cache_control).toBeUndefined()
    })
  })
})
