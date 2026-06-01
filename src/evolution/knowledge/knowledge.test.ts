import { describe, it, expect, vi, beforeEach } from "vitest"
import { KnowledgeStore } from "./store.js"
import { BackgroundReviewer } from "./background-review.js"
import { Curator } from "./curator.js"
import { parseReviewResponse, buildReviewSystemPrompt, buildReviewUserMessage } from "./rubric.js"
import type { TurnContext } from "./background-review.js"

// ── KnowledgeStore ───────────────────────────────────────────────────────────

describe("KnowledgeStore", () => {
  let store: KnowledgeStore

  beforeEach(() => {
    store = new KnowledgeStore()
  })

  describe("add / get", () => {
    it("adds a knowledge entry and retrieves it", () => {
      const entry = store.add({
        content: "User prefers snake_case in Python",
        category: "user_preference",
        source: { sessionId: "s1", turnIndex: 3, timestamp: Date.now() },
        tags: ["python", "naming"],
      })

      expect(entry.id).toMatch(/^k_/)
      expect(entry.status).toBe("active")
      expect(entry.confidence).toBe(0.8)

      const retrieved = store.get(entry.id)
      expect(retrieved).toEqual(entry)
    })

    it("assigns pinned status when specified", () => {
      const entry = store.add({
        content: "Important rule",
        category: "correction",
        source: { sessionId: "s1", timestamp: Date.now() },
        pinned: true,
      })
      expect(entry.status).toBe("pinned")
    })
  })

  describe("update", () => {
    it("updates content and confidence", () => {
      const entry = store.add({
        content: "old",
        category: "technique",
        source: { sessionId: "s1", timestamp: Date.now() },
      })
      store.update(entry.id, { content: "new", confidence: 0.95 })
      expect(store.get(entry.id)!.content).toBe("new")
      expect(store.get(entry.id)!.confidence).toBe(0.95)
    })

    it("returns false for non-existent ID", () => {
      expect(store.update("fake_id", { content: "x" })).toBe(false)
    })
  })

  describe("markReferenced", () => {
    it("increments reference count and reactivates stale entries", () => {
      const entry = store.add({
        content: "test",
        category: "technique",
        source: { sessionId: "s1", timestamp: Date.now() },
      })
      store.update(entry.id, { status: "stale" })
      expect(store.get(entry.id)!.status).toBe("stale")

      store.markReferenced(entry.id)
      expect(store.get(entry.id)!.referenceCount).toBe(1)
      expect(store.get(entry.id)!.status).toBe("active")
    })
  })

  describe("archive", () => {
    it("archives an active entry with absorbedInto pointer", () => {
      const entry = store.add({
        content: "test",
        category: "technique",
        source: { sessionId: "s1", timestamp: Date.now() },
      })
      const result = store.archive(entry.id, "umbrella_123")
      expect(result).toBe(true)
      expect(store.get(entry.id)!.status).toBe("archived")
      expect(store.get(entry.id)!.absorbedInto).toBe("umbrella_123")
    })

    it("cannot archive pinned entries", () => {
      const entry = store.add({
        content: "pinned",
        category: "technique",
        source: { sessionId: "s1", timestamp: Date.now() },
        pinned: true,
      })
      expect(store.archive(entry.id)).toBe(false)
      expect(store.get(entry.id)!.status).toBe("pinned")
    })
  })

  describe("query", () => {
    it("filters by category", () => {
      store.add({ content: "pref", category: "user_preference", source: { sessionId: "s1", timestamp: Date.now() } })
      store.add({ content: "tech", category: "technique", source: { sessionId: "s1", timestamp: Date.now() } })

      const results = store.query({ category: "user_preference" })
      expect(results.length).toBe(1)
      expect(results[0].content).toBe("pref")
    })

    it("filters by status array", () => {
      store.add({ content: "a", category: "technique", source: { sessionId: "s1", timestamp: Date.now() } })
      const e2 = store.add({ content: "b", category: "technique", source: { sessionId: "s1", timestamp: Date.now() }, pinned: true })

      const results = store.query({ status: ["active", "pinned"] })
      expect(results.length).toBe(2)
    })

    it("searches by content text", () => {
      store.add({ content: "Use TypeScript strict mode", category: "technique", source: { sessionId: "s1", timestamp: Date.now() } })
      store.add({ content: "Python black formatter", category: "user_preference", source: { sessionId: "s1", timestamp: Date.now() } })

      const results = store.query({ search: "typescript" })
      expect(results.length).toBe(1)
      expect(results[0].content).toContain("TypeScript")
    })

    it("filters by tags", () => {
      store.add({ content: "a", category: "technique", source: { sessionId: "s1", timestamp: Date.now() }, tags: ["python"] })
      store.add({ content: "b", category: "technique", source: { sessionId: "s1", timestamp: Date.now() }, tags: ["typescript"] })

      const results = store.query({ tags: ["python"] })
      expect(results.length).toBe(1)
    })

    it("respects limit", () => {
      for (let i = 0; i < 10; i++) {
        store.add({ content: `item ${i}`, category: "technique", source: { sessionId: "s1", timestamp: Date.now() } })
      }
      const results = store.query({ limit: 3 })
      expect(results.length).toBe(3)
    })
  })

  describe("runLifecycle", () => {
    it("transitions active entries to stale after 30 days", () => {
      const entry = store.add({
        content: "old",
        category: "technique",
        source: { sessionId: "s1", timestamp: Date.now() },
      })
      // Manually backdate
      const e = store.get(entry.id)!
      e.createdAt = Date.now() - 31 * 24 * 60 * 60 * 1000
      e.lastReferencedAt = 0

      const result = store.runLifecycle()
      expect(result.staled).toBe(1)
      expect(store.get(entry.id)!.status).toBe("stale")
    })

    it("does not affect pinned entries", () => {
      const entry = store.add({
        content: "pinned old",
        category: "technique",
        source: { sessionId: "s1", timestamp: Date.now() },
        pinned: true,
      })
      const e = store.get(entry.id)!
      e.createdAt = Date.now() - 100 * 24 * 60 * 60 * 1000

      const result = store.runLifecycle()
      expect(result.staled).toBe(0)
      expect(store.get(entry.id)!.status).toBe("pinned")
    })
  })

  describe("findSimilar", () => {
    it("finds entries with overlapping content", () => {
      store.add({ content: "User prefers tabs over spaces", category: "user_preference", source: { sessionId: "s1", timestamp: Date.now() } })
      store.add({ content: "Something else entirely", category: "technique", source: { sessionId: "s1", timestamp: Date.now() } })

      const similar = store.findSimilar("User prefers tabs over spaces in Python")
      expect(similar.length).toBe(1)
    })
  })

  describe("getStats", () => {
    it("returns correct counts per status", () => {
      store.add({ content: "a", category: "technique", source: { sessionId: "s1", timestamp: Date.now() } })
      store.add({ content: "b", category: "technique", source: { sessionId: "s1", timestamp: Date.now() }, pinned: true })

      const stats = store.getStats()
      expect(stats.active).toBe(1)
      expect(stats.pinned).toBe(1)
      expect(stats.stale).toBe(0)
      expect(stats.archived).toBe(0)
    })
  })

  describe("export / import", () => {
    it("round-trips entries through export/import", () => {
      store.add({ content: "a", category: "technique", source: { sessionId: "s1", timestamp: Date.now() } })
      store.add({ content: "b", category: "correction", source: { sessionId: "s1", timestamp: Date.now() } })

      const exported = store.export()
      const newStore = new KnowledgeStore()
      newStore.import(exported)
      expect(newStore.size).toBe(2)
    })
  })
})

// ── BackgroundReviewer ───────────────────────────────────────────────────────

describe("BackgroundReviewer", () => {
  let store: KnowledgeStore
  let mockChat: ReturnType<typeof vi.fn>

  beforeEach(() => {
    store = new KnowledgeStore()
    mockChat = vi.fn()
  })

  it("extracts knowledge from a turn and persists it", async () => {
    mockChat.mockResolvedValue({
      content: JSON.stringify([
        {
          content: "User prefers TypeScript strict mode",
          category: "user_preference",
          tags: ["typescript", "config"],
          confidence: 0.9,
          reasoning: "User explicitly asked for strict mode",
        },
      ]),
    })

    const reviewer = new BackgroundReviewer({
      store,
      chatFn: mockChat,
      config: { enabled: true, cooldownMs: 0, minConfidence: 0.5, maxItemsPerTurn: 3 },
    })

    const turn: TurnContext = {
      sessionId: "s1",
      turnIndex: 1,
      userMessage: "Always use strict mode in tsconfig",
      assistantResponse: "I'll remember that you prefer strict mode.",
    }

    const results = await reviewer.review(turn)
    expect(results.length).toBe(1)
    expect(results[0].content).toBe("User prefers TypeScript strict mode")
    expect(store.size).toBe(1)
    expect(store.getActiveKnowledge()[0].category).toBe("user_preference")
  })

  it("skips review when disabled", async () => {
    const reviewer = new BackgroundReviewer({
      store,
      chatFn: mockChat,
      config: { enabled: false, cooldownMs: 0, minConfidence: 0.5, maxItemsPerTurn: 3 },
    })

    const results = await reviewer.review({
      sessionId: "s1",
      turnIndex: 1,
      userMessage: "test",
      assistantResponse: "test response",
    })
    expect(results).toEqual([])
    expect(mockChat).not.toHaveBeenCalled()
  })

  it("filters items below confidence threshold", async () => {
    mockChat.mockResolvedValue({
      content: JSON.stringify([
        { content: "low conf", category: "technique", tags: [], confidence: 0.3, reasoning: "" },
        { content: "high conf", category: "technique", tags: [], confidence: 0.9, reasoning: "" },
      ]),
    })

    const reviewer = new BackgroundReviewer({
      store,
      chatFn: mockChat,
      config: { enabled: true, cooldownMs: 0, minConfidence: 0.7, maxItemsPerTurn: 3 },
    })

    const results = await reviewer.review({
      sessionId: "s1",
      turnIndex: 1,
      userMessage: "hello world this is a test message",
      assistantResponse: "I see, this is a detailed response for testing purposes.",
    })
    expect(results.length).toBe(1)
    expect(results[0].content).toBe("high conf")
  })

  it("respects cooldown between reviews", async () => {
    mockChat.mockResolvedValue({ content: "[]" })

    const reviewer = new BackgroundReviewer({
      store,
      chatFn: mockChat,
      config: { enabled: true, cooldownMs: 60000, minConfidence: 0.5, maxItemsPerTurn: 3 },
    })

    const turn: TurnContext = {
      sessionId: "s1",
      turnIndex: 1,
      userMessage: "hello world this is a test message",
      assistantResponse: "I see, this is a detailed response for testing purposes.",
    }

    await reviewer.review(turn)
    const results2 = await reviewer.review(turn) // Should skip due to cooldown
    expect(results2).toEqual([])
    expect(mockChat).toHaveBeenCalledOnce()
  })

  it("deduplicates and reinforces existing knowledge", async () => {
    // Pre-populate store
    store.add({
      content: "User prefers dark theme",
      category: "user_preference",
      source: { sessionId: "s0", timestamp: Date.now() },
      confidence: 0.7,
    })

    mockChat.mockResolvedValue({
      content: JSON.stringify([
        { content: "User prefers dark theme", category: "user_preference", tags: [], confidence: 0.9, reasoning: "" },
      ]),
    })

    const reviewer = new BackgroundReviewer({
      store,
      chatFn: mockChat,
      config: { enabled: true, cooldownMs: 0, minConfidence: 0.5, maxItemsPerTurn: 3 },
    })

    await reviewer.review({
      sessionId: "s1",
      turnIndex: 1,
      userMessage: "remember i like dark mode",
      assistantResponse: "Got it, dark theme preference noted.",
    })

    // Should NOT add a new entry (dedup), just reinforce
    expect(store.size).toBe(1)
    expect(store.getActiveKnowledge()[0].confidence).toBeCloseTo(0.8, 5)
  })

  it("handles LLM errors gracefully", async () => {
    mockChat.mockRejectedValue(new Error("API timeout"))

    const reviewer = new BackgroundReviewer({
      store,
      chatFn: mockChat,
      config: { enabled: true, cooldownMs: 0, minConfidence: 0.5, maxItemsPerTurn: 3 },
    })

    const results = await reviewer.review({
      sessionId: "s1",
      turnIndex: 1,
      userMessage: "this is a test message longer than minimum",
      assistantResponse: "this is a response longer than minimum length requirement for review",
    })
    expect(results).toEqual([])
    expect(store.size).toBe(0)
  })
})

// ── Curator ──────────────────────────────────────────────────────────────────

describe("Curator", () => {
  let store: KnowledgeStore

  beforeEach(() => {
    store = new KnowledgeStore()
  })

  it("runs lifecycle transitions", async () => {
    const entry = store.add({
      content: "old knowledge",
      category: "technique",
      source: { sessionId: "s1", timestamp: Date.now() },
    })
    // Backdate to trigger stale
    const e = store.get(entry.id)!
    e.createdAt = Date.now() - 31 * 24 * 60 * 60 * 1000
    e.lastReferencedAt = 0

    const curator = new Curator({ store, config: { enabled: true, intervalMs: 0, minClusterSize: 3 } })
    const report = await curator.run()

    expect(report.dryRun).toBe(false)
    expect(report.actions.length).toBeGreaterThanOrEqual(1)
    expect(store.get(entry.id)!.status).toBe("stale")
  })

  it("merges clusters into umbrella entries", async () => {
    // Create a cluster of similar entries
    for (let i = 0; i < 4; i++) {
      store.add({
        content: `User prefers strict mode option ${i}`,
        category: "user_preference",
        source: { sessionId: "s1", timestamp: Date.now() },
        tags: ["typescript"],
      })
    }

    const curator = new Curator({
      store,
      config: { enabled: true, intervalMs: 0, minClusterSize: 3 },
    })

    const report = await curator.run()
    // Should have found and merged the cluster
    expect(report.stats.clustersFound).toBeGreaterThanOrEqual(1)
    // Some entries should now be archived
    const stats = store.getStats()
    expect(stats.archived).toBeGreaterThan(0)
  })

  it("dry-run mode produces report without changes", async () => {
    for (let i = 0; i < 4; i++) {
      store.add({
        content: `Pattern item ${i}`,
        category: "behavioral_pattern",
        source: { sessionId: "s1", timestamp: Date.now() },
        tags: ["workflow"],
      })
    }

    const curator = new Curator({
      store,
      config: { enabled: true, intervalMs: 0, minClusterSize: 3 },
    })

    const report = await curator.run(true) // dry-run
    expect(report.dryRun).toBe(true)
    // No entries should be archived in dry-run
    expect(store.getStats().archived).toBe(0)
  })

  it("isDue returns true after interval passes", () => {
    const curator = new Curator({
      store,
      config: { enabled: true, intervalMs: 1000, minClusterSize: 3 },
    })
    expect(curator.isDue()).toBe(true) // Never run before
  })

  it("formats report as markdown", async () => {
    const curator = new Curator({
      store,
      config: { enabled: true, intervalMs: 0, minClusterSize: 3 },
    })
    const report = await curator.run()
    const md = curator.formatReport(report)
    expect(md).toContain("# Knowledge Curation Report")
    expect(md).toContain("LIVE")
  })

  it("uses LLM for umbrella generation when available", async () => {
    const mockChat = vi.fn().mockResolvedValue({
      content: "Consolidated: User consistently prefers strict TypeScript configuration",
    })

    for (let i = 0; i < 4; i++) {
      store.add({
        content: `User prefers strict ts config variant ${i}`,
        category: "user_preference",
        source: { sessionId: "s1", timestamp: Date.now() },
        tags: ["typescript"],
      })
    }

    const curator = new Curator({
      store,
      chatFn: mockChat,
      config: { enabled: true, intervalMs: 0, minClusterSize: 3 },
    })

    await curator.run()
    // LLM should have been called for umbrella generation
    expect(mockChat).toHaveBeenCalled()
  })
})

// ── Rubric ───────────────────────────────────────────────────────────────────

describe("Rubric", () => {
  describe("parseReviewResponse", () => {
    it("parses clean JSON array", () => {
      const input = JSON.stringify([
        { content: "Test", category: "technique", tags: ["test"], confidence: 0.8, reasoning: "r" },
      ])
      const results = parseReviewResponse(input)
      expect(results.length).toBe(1)
      expect(results[0].content).toBe("Test")
    })

    it("handles markdown-wrapped JSON", () => {
      const input = "```json\n[{\"content\":\"Test\",\"category\":\"technique\",\"tags\":[],\"confidence\":0.9,\"reasoning\":\"r\"}]\n```"
      const results = parseReviewResponse(input)
      expect(results.length).toBe(1)
    })

    it("handles response with text before JSON", () => {
      const input = "Here are the results:\n[{\"content\":\"X\",\"category\":\"technique\",\"tags\":[],\"confidence\":0.7,\"reasoning\":\"r\"}]"
      const results = parseReviewResponse(input)
      expect(results.length).toBe(1)
    })

    it("returns empty array for invalid JSON", () => {
      expect(parseReviewResponse("not json")).toEqual([])
    })

    it("returns empty array for empty response", () => {
      expect(parseReviewResponse("[]")).toEqual([])
    })

    it("filters out items with invalid confidence", () => {
      const input = JSON.stringify([
        { content: "Bad", category: "technique", tags: [], confidence: 2.0, reasoning: "r" },
        { content: "Good", category: "technique", tags: [], confidence: 0.8, reasoning: "r" },
      ])
      const results = parseReviewResponse(input)
      expect(results.length).toBe(1)
      expect(results[0].content).toBe("Good")
    })
  })

  describe("buildReviewSystemPrompt", () => {
    it("includes learning priorities and anti-patterns", () => {
      const prompt = buildReviewSystemPrompt()
      expect(prompt).toContain("user_preference")
      expect(prompt).toContain("anti-pattern")
      expect(prompt).toContain("NEVER extract sensitive information")
    })
  })

  describe("buildReviewUserMessage", () => {
    it("includes user and assistant messages", () => {
      const msg = buildReviewUserMessage({
        userMessage: "Hello",
        assistantResponse: "Hi there!",
      })
      expect(msg).toContain("Hello")
      expect(msg).toContain("Hi there!")
    })

    it("includes tool calls when provided", () => {
      const msg = buildReviewUserMessage({
        userMessage: "Read file",
        assistantResponse: "Done",
        toolCalls: [{ name: "read_file", result: "file content..." }],
      })
      expect(msg).toContain("read_file")
    })
  })
})
