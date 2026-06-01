/**
 * Tests for KnowledgeIntentSource and EvolutionBridge.
 *
 * Validates:
 * - Intent generation from corrections, techniques, behavioral patterns
 * - Clustering logic
 * - Deduplication
 * - Queue management in bridge
 * - Config overrides
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { KnowledgeStore } from "./store.js"
import { KnowledgeIntentSource } from "./intent-source.js"
import { EvolutionBridge } from "./evolution-bridge.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStore(): KnowledgeStore {
  return new KnowledgeStore()
}

function addEntry(
  store: KnowledgeStore,
  overrides: {
    content?: string
    category?: "correction" | "technique" | "behavioral_pattern" | "user_preference" | "domain_knowledge"
    confidence?: number
    tags?: string[]
  } = {},
) {
  return store.add({
    content: overrides.content ?? "Test entry",
    category: overrides.category ?? "correction",
    source: { sessionId: "sess-1", turnIndex: 1, timestamp: Date.now() },
    tags: overrides.tags ?? [],
    confidence: overrides.confidence ?? 0.9,
  })
}

// ── KnowledgeIntentSource ────────────────────────────────────────────────────

describe("KnowledgeIntentSource", () => {
  let store: KnowledgeStore

  beforeEach(() => {
    store = makeStore()
  })

  describe("corrections → behavior_fix", () => {
    it("generates behavior_fix intent from high-confidence correction", () => {
      addEntry(store, {
        content: "Never use console.log in src/server/routes.ts",
        category: "correction",
        confidence: 0.9,
        tags: ["src/server/routes.ts"],
      })

      const source = new KnowledgeIntentSource(store)
      const candidates = source.analyze()

      expect(candidates).toHaveLength(1)
      expect(candidates[0].type).toBe("behavior_fix")
      expect(candidates[0].description).toContain("Never use console.log")
      expect(candidates[0].targetFiles).toContain("src/server/routes.ts")
      expect(candidates[0].riskLevel).toBe("low")
    })

    it("ignores low-confidence corrections", () => {
      addEntry(store, {
        content: "Maybe avoid X",
        category: "correction",
        confidence: 0.5,
      })

      const source = new KnowledgeIntentSource(store)
      const candidates = source.analyze()
      expect(candidates).toHaveLength(0)
    })

    it("extracts file paths from content", () => {
      addEntry(store, {
        content: "The handler in src/server/routes.ts should validate before calling src/providers/anthropic.ts",
        category: "correction",
        confidence: 0.85,
      })

      const source = new KnowledgeIntentSource(store)
      const candidates = source.analyze()
      expect(candidates[0].targetFiles).toContain("src/server/routes.ts")
      expect(candidates[0].targetFiles).toContain("src/providers/anthropic.ts")
    })

    it("assigns medium risk when > 2 target files", () => {
      addEntry(store, {
        content: "Fix error handling in src/a.ts, src/b.ts, src/c.ts",
        category: "correction",
        confidence: 0.9,
        tags: ["src/a.ts", "src/b.ts", "src/c.ts"],
      })

      const source = new KnowledgeIntentSource(store)
      const candidates = source.analyze()
      expect(candidates[0].riskLevel).toBe("medium")
    })
  })

  describe("techniques → optimization", () => {
    it("generates optimization intent from technique cluster (≥3)", () => {
      addEntry(store, { content: "Use memoization for expensive calls", category: "technique", tags: ["performance"], confidence: 0.8 })
      addEntry(store, { content: "Cache repeated computations", category: "technique", tags: ["performance"], confidence: 0.85 })
      addEntry(store, { content: "Avoid recalculating in loops", category: "technique", tags: ["performance"], confidence: 0.9 })

      const source = new KnowledgeIntentSource(store)
      const candidates = source.analyze()

      expect(candidates).toHaveLength(1)
      expect(candidates[0].type).toBe("optimization")
      expect(candidates[0].description).toContain("performance")
      expect(candidates[0].sourceEntryIds).toHaveLength(3)
    })

    it("does not trigger with fewer than 3 entries per tag", () => {
      addEntry(store, { content: "Use memoization", category: "technique", tags: ["perf"], confidence: 0.8 })
      addEntry(store, { content: "Cache results", category: "technique", tags: ["perf"], confidence: 0.85 })

      const source = new KnowledgeIntentSource(store)
      const candidates = source.analyze()
      expect(candidates).toHaveLength(0)
    })

    it("respects custom cluster min config", () => {
      addEntry(store, { content: "A", category: "technique", tags: ["x"], confidence: 0.8 })
      addEntry(store, { content: "B", category: "technique", tags: ["x"], confidence: 0.8 })

      const source = new KnowledgeIntentSource(store, { techniqueClusterMin: 2 })
      const candidates = source.analyze()
      expect(candidates).toHaveLength(1)
    })
  })

  describe("behavioral patterns → new_feature", () => {
    it("generates new_feature intent from pattern cluster (≥2)", () => {
      addEntry(store, { content: "User always runs tests before commit", category: "behavioral_pattern", tags: ["workflow"], confidence: 0.7 })
      addEntry(store, { content: "User checks lint before push", category: "behavioral_pattern", tags: ["workflow"], confidence: 0.8 })

      const source = new KnowledgeIntentSource(store)
      const candidates = source.analyze()

      expect(candidates).toHaveLength(1)
      expect(candidates[0].type).toBe("new_feature")
      expect(candidates[0].description).toContain("workflow")
      expect(candidates[0].riskLevel).toBe("medium")
    })

    it("skips low-confidence pattern clusters", () => {
      addEntry(store, { content: "Maybe does X", category: "behavioral_pattern", tags: ["maybe"], confidence: 0.4 })
      addEntry(store, { content: "Possibly does Y", category: "behavioral_pattern", tags: ["maybe"], confidence: 0.5 })

      const source = new KnowledgeIntentSource(store)
      const candidates = source.analyze()
      expect(candidates).toHaveLength(0) // avg confidence < 0.6
    })
  })

  describe("sorting and limiting", () => {
    it("sorts by confidence descending", () => {
      addEntry(store, { content: "Low conf fix", category: "correction", confidence: 0.81, tags: [] })
      addEntry(store, { content: "High conf fix", category: "correction", confidence: 0.95, tags: [] })

      const source = new KnowledgeIntentSource(store)
      const candidates = source.analyze()

      expect(candidates[0].confidence).toBeGreaterThan(candidates[1].confidence)
    })

    it("respects maxIntentsPerRun limit", () => {
      for (let i = 0; i < 10; i++) {
        addEntry(store, { content: `Fix ${i}`, category: "correction", confidence: 0.9 })
      }

      const source = new KnowledgeIntentSource(store, { maxIntentsPerRun: 3 })
      const candidates = source.analyze()
      expect(candidates).toHaveLength(3)
    })
  })

  describe("recent window filtering", () => {
    it("ignores entries older than the recent window", () => {
      const entry = addEntry(store, {
        content: "Old correction",
        category: "correction",
        confidence: 0.95,
      })
      // Manually backdate
      ;(entry as any).createdAt = Date.now() - 30 * 24 * 60 * 60 * 1000 // 30 days ago

      const source = new KnowledgeIntentSource(store, { recentWindowMs: 7 * 24 * 60 * 60 * 1000 })
      const candidates = source.analyze()
      expect(candidates).toHaveLength(0)
    })
  })
})

// ── EvolutionBridge ──────────────────────────────────────────────────────────

describe("EvolutionBridge", () => {
  let store: KnowledgeStore
  let bridge: EvolutionBridge

  beforeEach(() => {
    store = makeStore()
    bridge = new EvolutionBridge(store, { autoApproveLowRisk: true, maxQueueSize: 5 })
  })

  describe("generateIntents", () => {
    it("converts knowledge insights into EvolutionIntents", async () => {
      addEntry(store, {
        content: "Always validate input in src/server/routes.ts",
        category: "correction",
        confidence: 0.9,
        tags: ["src/server/routes.ts"],
      })

      const intents = await bridge.generateIntents()
      expect(intents).toHaveLength(1)
      expect(intents[0].id).toMatch(/^ki_/)
      expect(intents[0].type).toBe("behavior_fix")
      expect(intents[0].requiresHumanApproval).toBe(false) // low risk + autoApproveLowRisk
    })

    it("requires approval for medium/high risk even with autoApproveLowRisk", async () => {
      addEntry(store, {
        content: "Refactor src/a.ts, src/b.ts, src/c.ts error handling",
        category: "correction",
        confidence: 0.9,
        tags: ["src/a.ts", "src/b.ts", "src/c.ts"],
      })

      const intents = await bridge.generateIntents()
      expect(intents[0].requiresHumanApproval).toBe(true)
    })

    it("deduplicates entries that have already produced intents", async () => {
      addEntry(store, {
        content: "Fix something",
        category: "correction",
        confidence: 0.9,
      })

      const first = await bridge.generateIntents()
      expect(first).toHaveLength(1)

      const second = await bridge.generateIntents()
      expect(second).toHaveLength(0)

      expect(bridge.getStats().deduplicatedCount).toBe(1)
    })

    it("respects maxQueueSize", async () => {
      for (let i = 0; i < 10; i++) {
        addEntry(store, { content: `Fix ${i}`, category: "correction", confidence: 0.9 })
      }

      const intents = await bridge.generateIntents()
      expect(intents.length).toBeLessThanOrEqual(5)
      expect(bridge.peekQueue().length).toBeLessThanOrEqual(5)
    })

    it("calls onIntentsGenerated callback", async () => {
      const cb = vi.fn()
      const bridgeWithCb = new EvolutionBridge(store, { onIntentsGenerated: cb })

      addEntry(store, { content: "Test", category: "correction", confidence: 0.9 })
      await bridgeWithCb.generateIntents()

      expect(cb).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ type: "behavior_fix" }),
      ]))
    })
  })

  describe("queue operations", () => {
    it("dequeueIntent returns and removes from queue", async () => {
      addEntry(store, { content: "Fix A", category: "correction", confidence: 0.9 })
      await bridge.generateIntents()

      const intent = bridge.dequeueIntent()
      expect(intent).toBeDefined()
      expect(intent!.type).toBe("behavior_fix")
      expect(bridge.peekQueue()).toHaveLength(0)
    })

    it("dequeueIntent returns undefined when empty", () => {
      expect(bridge.dequeueIntent()).toBeUndefined()
    })

    it("drainQueue returns all and empties", async () => {
      addEntry(store, { content: "Fix A", category: "correction", confidence: 0.9 })
      addEntry(store, { content: "Fix B", category: "correction", confidence: 0.85 })
      await bridge.generateIntents()

      const all = bridge.drainQueue()
      expect(all).toHaveLength(2)
      expect(bridge.peekQueue()).toHaveLength(0)
    })
  })

  describe("stats", () => {
    it("tracks generation stats", async () => {
      addEntry(store, { content: "Fix", category: "correction", confidence: 0.9 })
      await bridge.generateIntents()

      const stats = bridge.getStats()
      expect(stats.totalGenerated).toBe(1)
      expect(stats.totalConverted).toBe(1)
      expect(stats.lastRunAt).toBeTypeOf("number")
    })

    it("resetProcessedEntries allows re-processing", async () => {
      addEntry(store, { content: "Fix", category: "correction", confidence: 0.9 })
      await bridge.generateIntents()

      bridge.resetProcessedEntries()
      bridge.drainQueue() // Clear queue to make room

      const intents = await bridge.generateIntents()
      expect(intents).toHaveLength(1)
    })
  })
})
