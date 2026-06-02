/**
 * Tests for IntentAggregator.
 */
import { describe, it, expect, vi } from "vitest"
import {
  IntentAggregator,
  computePriority,
  type IntentSource,
  type RawIntent,
} from "./intent-aggregator.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRaw(overrides?: Partial<RawIntent>): RawIntent {
  return {
    type: "behavior_fix",
    description: "Fix null handling",
    targetFiles: ["src/foo.ts"],
    evidence: ["Error in logs"],
    riskLevel: "low",
    ...overrides,
  }
}

function makeSource(
  name: string,
  intents: RawIntent[] | (() => RawIntent[]),
): IntentSource {
  return {
    name,
    generate: typeof intents === "function" ? intents : () => intents,
  }
}

// ── computePriority tests ────────────────────────────────────────────────────

describe("computePriority", () => {
  it("gives behavior_fix a higher score than new_feature", () => {
    const fix = computePriority(makeRaw({ type: "behavior_fix" }))
    const feature = computePriority(makeRaw({ type: "new_feature" }))
    expect(fix).toBeGreaterThan(feature)
  })

  it("applies risk penalty", () => {
    const low = computePriority(makeRaw({ riskLevel: "low" }))
    const high = computePriority(makeRaw({ riskLevel: "high" }))
    expect(low).toBeGreaterThan(high)
  })

  it("boosts for more evidence", () => {
    const few = computePriority(makeRaw({ evidence: ["one"] }))
    const many = computePriority(
      makeRaw({ evidence: ["a", "b", "c", "d"] }),
    )
    expect(many).toBeGreaterThan(few)
  })

  it("clamps to [0, 1]", () => {
    const result = computePriority(makeRaw({ priority: 2.0 }))
    expect(result).toBeLessThanOrEqual(1)
    expect(result).toBeGreaterThanOrEqual(0)
  })

  it("uses source priority hint", () => {
    const highPri = computePriority(makeRaw({ priority: 0.9 }))
    const lowPri = computePriority(makeRaw({ priority: 0.1 }))
    expect(highPri).toBeGreaterThan(lowPri)
  })
})

// ── IntentAggregator tests ───────────────────────────────────────────────────

describe("IntentAggregator", () => {
  it("collects intents from multiple sources", async () => {
    const agg = new IntentAggregator()
    agg.addSource(makeSource("knowledge", [makeRaw()]))
    agg.addSource(
      makeSource("upstream", [
        makeRaw({ type: "upstream_sync", description: "Sync v2" }),
      ]),
    )

    const result = await agg.collect()

    expect(result).toHaveLength(2)
    expect(agg.size()).toBe(2)
  })

  it("deduplicates by dedupKey", async () => {
    const agg = new IntentAggregator()
    agg.addSource(
      makeSource("s1", [makeRaw({ dedupKey: "same-key" })]),
    )
    agg.addSource(
      makeSource("s2", [makeRaw({ dedupKey: "same-key" })]),
    )

    const result = await agg.collect()

    expect(result).toHaveLength(1)
    expect(agg.getStats().totalDeduplicated).toBe(1)
  })

  it("deduplicates same intent across multiple collect calls", async () => {
    const agg = new IntentAggregator()
    agg.addSource(makeSource("s1", [makeRaw({ dedupKey: "dup" })]))

    await agg.collect()
    const second = await agg.collect()

    expect(second).toHaveLength(0) // already processed
  })

  it("returns intents sorted by priority (highest first)", async () => {
    const agg = new IntentAggregator()
    agg.addSource(
      makeSource("mixed", [
        makeRaw({ type: "new_feature", priority: 0.1, dedupKey: "a" }),
        makeRaw({ type: "behavior_fix", priority: 0.9, dedupKey: "b" }),
        makeRaw({ type: "optimization", priority: 0.5, dedupKey: "c" }),
      ]),
    )

    await agg.collect()
    const first = agg.next()
    const second = agg.next()
    const third = agg.next()

    expect(first!.type).toBe("behavior_fix") // highest priority
    expect(third!.type).toBe("new_feature") // lowest priority
  })

  it("respects maxQueueSize", async () => {
    const agg = new IntentAggregator({ maxQueueSize: 3 })
    const intents = Array.from({ length: 10 }, (_, i) =>
      makeRaw({ dedupKey: `k${i}`, description: `Intent ${i}` }),
    )
    agg.addSource(makeSource("big", intents))

    await agg.collect()

    expect(agg.size()).toBe(3)
  })

  it("next() returns null on empty queue", () => {
    const agg = new IntentAggregator()
    expect(agg.next()).toBeNull()
  })

  it("peek() does not consume items", async () => {
    const agg = new IntentAggregator()
    agg.addSource(makeSource("s", [makeRaw()]))
    await agg.collect()

    const peeked = agg.peek()
    expect(peeked).toHaveLength(1)
    expect(agg.size()).toBe(1) // still there
  })

  it("clearQueue() empties the queue", async () => {
    const agg = new IntentAggregator()
    agg.addSource(makeSource("s", [makeRaw()]))
    await agg.collect()

    agg.clearQueue()
    expect(agg.size()).toBe(0)
  })

  it("handles source failure gracefully", async () => {
    const agg = new IntentAggregator()
    const failSource: IntentSource = {
      name: "broken",
      generate: () => { throw new Error("oops") },
    }
    agg.addSource(failSource)
    agg.addSource(makeSource("good", [makeRaw()]))

    const result = await agg.collect()
    expect(result).toHaveLength(1) // only from good source
  })

  it("sets requiresHumanApproval for high risk", async () => {
    const agg = new IntentAggregator({ requireApprovalForHighRisk: true })
    agg.addSource(
      makeSource("s", [makeRaw({ riskLevel: "high" })]),
    )

    await agg.collect()
    const intent = agg.next()

    expect(intent!.requiresHumanApproval).toBe(true)
  })

  it("does not set requiresHumanApproval for low risk", async () => {
    const agg = new IntentAggregator()
    agg.addSource(makeSource("s", [makeRaw({ riskLevel: "low" })]))

    await agg.collect()
    const intent = agg.next()

    expect(intent!.requiresHumanApproval).toBe(false)
  })

  it("tracks stats correctly", async () => {
    const agg = new IntentAggregator()
    agg.addSource(
      makeSource("knowledge", [
        makeRaw({ dedupKey: "a" }),
        makeRaw({ dedupKey: "b" }),
      ]),
    )
    agg.addSource(makeSource("upstream", [makeRaw({ dedupKey: "a" })]))

    await agg.collect()
    const stats = agg.getStats()

    expect(stats.totalCollected).toBe(3)
    expect(stats.totalDeduplicated).toBe(1)
    expect(stats.queueSize).toBe(2)
    expect(stats.sourceBreakdown.knowledge).toBe(2)
    expect(stats.sourceBreakdown.upstream).toBe(1)
    expect(stats.lastRunAt).not.toBeNull()
  })

  it("clearSources removes all registered sources", async () => {
    const agg = new IntentAggregator()
    agg.addSource(makeSource("s", [makeRaw()]))
    agg.clearSources()

    const result = await agg.collect()
    expect(result).toHaveLength(0)
  })
})
