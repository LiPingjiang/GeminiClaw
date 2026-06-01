/**
 * UpstreamTracker Tests
 *
 * Covers:
 * - Initial bookmark setup
 * - New commit detection
 * - Intent generation from diff analysis
 * - Relevance threshold filtering
 * - Bookmark advancement
 * - Cron start/stop
 * - Error handling (consecutive failures)
 * - Queue operations (drain/peek)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  UpstreamTracker,
  type UpstreamGitOps,
  type DiffAnalyzer,
  type UpstreamRepo,
  type DiffAnalysisResult,
} from "./upstream-tracker.js"

// ── Mocks ────────────────────────────────────────────────────────────────────

function createMockGitOps(overrides?: Partial<UpstreamGitOps>): UpstreamGitOps {
  return {
    fetch: vi.fn(async () => {}),
    getHeadCommit: vi.fn(async () => "commit-2"),
    getLog: vi.fn(async () => ["abc123 Fix bug", "def456 Add feature"]),
    getDiffStat: vi.fn(async () => "2 files changed, 30 insertions(+), 5 deletions(-)"),
    getChangedFiles: vi.fn(async () => ["src/foo.ts", "src/bar.ts"]),
    ...overrides,
  }
}

function createMockAnalyzer(results: DiffAnalysisResult[] = []): DiffAnalyzer {
  return {
    analyze: vi.fn(async () => results),
  }
}

function makeRepo(overrides?: Partial<UpstreamRepo>): UpstreamRepo {
  return {
    name: "upstream-project",
    path: "/tmp/upstream",
    remote: "origin",
    branch: "main",
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("UpstreamTracker", () => {
  let git: UpstreamGitOps
  let analyzer: DiffAnalyzer
  let tracker: UpstreamTracker

  afterEach(() => {
    tracker?.stop()
  })

  describe("initial bookmark setup", () => {
    it("records HEAD as bookmark on first check (no prior bookmark)", async () => {
      git = createMockGitOps({ getHeadCommit: vi.fn(async () => "initial-commit") })
      analyzer = createMockAnalyzer()
      tracker = new UpstreamTracker(git, analyzer, {
        repos: [makeRepo()],
      })

      const results = await tracker.checkAll()
      expect(results[0].newCommits).toBe(0)
      expect(results[0].intentsGenerated).toBe(0)
      expect(tracker.getBookmark("upstream-project")).toBe("initial-commit")
    })

    it("uses lastKnownCommit from config as initial bookmark", () => {
      git = createMockGitOps()
      analyzer = createMockAnalyzer()
      tracker = new UpstreamTracker(git, analyzer, {
        repos: [makeRepo({ lastKnownCommit: "abc123" })],
      })

      expect(tracker.getBookmark("upstream-project")).toBe("abc123")
    })
  })

  describe("new commit detection", () => {
    beforeEach(() => {
      git = createMockGitOps({
        getHeadCommit: vi.fn(async () => "commit-new"),
        getLog: vi.fn(async () => ["commit-new Fix something"]),
        getChangedFiles: vi.fn(async () => ["src/x.ts"]),
      })
    })

    it("detects new commits when HEAD differs from bookmark", async () => {
      analyzer = createMockAnalyzer([
        {
          description: "Adopt new error handling pattern",
          targetFiles: ["src/server/error.ts"],
          riskLevel: "low",
          evidence: ["commit-new introduces try/catch pattern"],
          relevanceScore: 0.8,
        },
      ])
      tracker = new UpstreamTracker(git, analyzer, {
        repos: [makeRepo({ lastKnownCommit: "commit-old" })],
      })

      const results = await tracker.checkAll()
      expect(results[0].newCommits).toBe(1)
      expect(results[0].intentsGenerated).toBe(1)
    })

    it("skips when HEAD matches bookmark (no new commits)", async () => {
      git = createMockGitOps({ getHeadCommit: vi.fn(async () => "same-commit") })
      analyzer = createMockAnalyzer()
      tracker = new UpstreamTracker(git, analyzer, {
        repos: [makeRepo({ lastKnownCommit: "same-commit" })],
      })

      const results = await tracker.checkAll()
      expect(results[0].newCommits).toBe(0)
      expect(analyzer.analyze).not.toHaveBeenCalled()
    })
  })

  describe("intent generation", () => {
    it("generates EvolutionIntent with upstream_sync type", async () => {
      git = createMockGitOps({ getHeadCommit: vi.fn(async () => "new-head") })
      analyzer = createMockAnalyzer([
        {
          description: "Add rate limiting middleware",
          targetFiles: ["src/server/middleware.ts"],
          riskLevel: "medium",
          evidence: ["Upstream added rate limiting"],
          relevanceScore: 0.9,
        },
      ])
      tracker = new UpstreamTracker(git, analyzer, {
        repos: [makeRepo({ lastKnownCommit: "old-head" })],
      })

      await tracker.checkAll()
      const intents = tracker.drainIntents()

      expect(intents).toHaveLength(1)
      expect(intents[0].type).toBe("upstream_sync")
      expect(intents[0].id).toMatch(/^us_/)
      expect(intents[0].description).toContain("upstream-project")
      expect(intents[0].description).toContain("rate limiting")
      expect(intents[0].targetFiles).toEqual(["src/server/middleware.ts"])
      expect(intents[0].riskLevel).toBe("medium")
      expect(intents[0].requiresHumanApproval).toBe(true) // medium risk
    })

    it("sets requiresHumanApproval=false for low-risk intents", async () => {
      git = createMockGitOps({ getHeadCommit: vi.fn(async () => "new") })
      analyzer = createMockAnalyzer([
        {
          description: "Adopt typo fix",
          targetFiles: ["src/utils.ts"],
          riskLevel: "low",
          evidence: ["Trivial fix"],
          relevanceScore: 0.7,
        },
      ])
      tracker = new UpstreamTracker(git, analyzer, {
        repos: [makeRepo({ lastKnownCommit: "old" })],
      })

      await tracker.checkAll()
      const intents = tracker.drainIntents()
      expect(intents[0].requiresHumanApproval).toBe(false)
    })
  })

  describe("relevance threshold filtering", () => {
    it("filters out low-relevance analysis results", async () => {
      git = createMockGitOps({ getHeadCommit: vi.fn(async () => "new") })
      analyzer = createMockAnalyzer([
        { description: "Relevant", targetFiles: [], riskLevel: "low", evidence: [], relevanceScore: 0.8 },
        { description: "Not relevant", targetFiles: [], riskLevel: "low", evidence: [], relevanceScore: 0.3 },
      ])
      tracker = new UpstreamTracker(git, analyzer, {
        repos: [makeRepo({ lastKnownCommit: "old" })],
        relevanceThreshold: 0.5,
      })

      await tracker.checkAll()
      const intents = tracker.drainIntents()
      expect(intents).toHaveLength(1)
      expect(intents[0].description).toContain("Relevant")
    })
  })

  describe("bookmark advancement", () => {
    it("updates bookmark after successful check", async () => {
      git = createMockGitOps({ getHeadCommit: vi.fn(async () => "new-commit") })
      analyzer = createMockAnalyzer()
      tracker = new UpstreamTracker(git, analyzer, {
        repos: [makeRepo({ lastKnownCommit: "old-commit" })],
      })

      await tracker.checkAll()
      expect(tracker.getBookmark("upstream-project")).toBe("new-commit")
    })

    it("setBookmark manually updates the bookmark", () => {
      git = createMockGitOps()
      analyzer = createMockAnalyzer()
      tracker = new UpstreamTracker(git, analyzer, {
        repos: [makeRepo()],
      })

      tracker.setBookmark("upstream-project", "manual-commit")
      expect(tracker.getBookmark("upstream-project")).toBe("manual-commit")
    })
  })

  describe("cron start/stop", () => {
    it("start sets running state", () => {
      git = createMockGitOps()
      analyzer = createMockAnalyzer()
      tracker = new UpstreamTracker(git, analyzer, { repos: [makeRepo()] })

      expect(tracker.isRunning()).toBe(false)
      tracker.start()
      expect(tracker.isRunning()).toBe(true)
    })

    it("stop clears running state", () => {
      git = createMockGitOps()
      analyzer = createMockAnalyzer()
      tracker = new UpstreamTracker(git, analyzer, { repos: [makeRepo()] })

      tracker.start()
      tracker.stop()
      expect(tracker.isRunning()).toBe(false)
    })

    it("start is idempotent", () => {
      git = createMockGitOps()
      analyzer = createMockAnalyzer()
      tracker = new UpstreamTracker(git, analyzer, { repos: [makeRepo()] })

      tracker.start()
      tracker.start()
      expect(tracker.isRunning()).toBe(true)
    })
  })

  describe("error handling", () => {
    it("tracks consecutive failures", async () => {
      git = createMockGitOps({
        fetch: vi.fn(async () => { throw new Error("network error") }),
      })
      analyzer = createMockAnalyzer()
      tracker = new UpstreamTracker(git, analyzer, {
        repos: [makeRepo({ lastKnownCommit: "abc" })],
      })

      await tracker.checkAll()
      expect(tracker.getStats().consecutiveFailures).toBe(1)

      await tracker.checkAll()
      expect(tracker.getStats().consecutiveFailures).toBe(2)
    })

    it("resets consecutive failures on success", async () => {
      let callCount = 0
      git = createMockGitOps({
        fetch: vi.fn(async () => {
          callCount++
          if (callCount === 1) throw new Error("network")
        }),
        getHeadCommit: vi.fn(async () => "same"),
      })
      analyzer = createMockAnalyzer()
      tracker = new UpstreamTracker(git, analyzer, {
        repos: [makeRepo({ lastKnownCommit: "same" })],
      })

      await tracker.checkAll() // failure
      expect(tracker.getStats().consecutiveFailures).toBe(1)

      await tracker.checkAll() // success
      expect(tracker.getStats().consecutiveFailures).toBe(0)
    })

    it("returns error info in check result", async () => {
      git = createMockGitOps({
        fetch: vi.fn(async () => { throw new Error("timeout") }),
      })
      analyzer = createMockAnalyzer()
      tracker = new UpstreamTracker(git, analyzer, {
        repos: [makeRepo({ lastKnownCommit: "abc" })],
      })

      const results = await tracker.checkAll()
      expect(results[0].error).toContain("timeout")
    })
  })

  describe("queue operations", () => {
    it("drainIntents returns and clears queue", async () => {
      git = createMockGitOps({ getHeadCommit: vi.fn(async () => "new") })
      analyzer = createMockAnalyzer([
        { description: "A", targetFiles: [], riskLevel: "low", evidence: [], relevanceScore: 0.9 },
      ])
      tracker = new UpstreamTracker(git, analyzer, {
        repos: [makeRepo({ lastKnownCommit: "old" })],
      })

      await tracker.checkAll()
      expect(tracker.peekIntents()).toHaveLength(1)

      const drained = tracker.drainIntents()
      expect(drained).toHaveLength(1)
      expect(tracker.peekIntents()).toHaveLength(0)
    })

    it("peekIntents does not consume", async () => {
      git = createMockGitOps({ getHeadCommit: vi.fn(async () => "new") })
      analyzer = createMockAnalyzer([
        { description: "B", targetFiles: [], riskLevel: "low", evidence: [], relevanceScore: 0.7 },
      ])
      tracker = new UpstreamTracker(git, analyzer, {
        repos: [makeRepo({ lastKnownCommit: "old" })],
      })

      await tracker.checkAll()
      tracker.peekIntents()
      expect(tracker.peekIntents()).toHaveLength(1)
    })
  })

  describe("stats", () => {
    it("tracks total checks and intents generated", async () => {
      git = createMockGitOps({ getHeadCommit: vi.fn(async () => "new") })
      analyzer = createMockAnalyzer([
        { description: "X", targetFiles: [], riskLevel: "low", evidence: [], relevanceScore: 0.8 },
      ])
      tracker = new UpstreamTracker(git, analyzer, {
        repos: [makeRepo({ lastKnownCommit: "old" })],
      })

      await tracker.checkAll()
      const stats = tracker.getStats()
      expect(stats.totalChecks).toBe(1)
      expect(stats.totalIntentsGenerated).toBe(1)
      expect(stats.lastCheckAt).toBeTypeOf("number")
    })
  })

  describe("multiple repos", () => {
    it("checks all configured repos", async () => {
      git = createMockGitOps({ getHeadCommit: vi.fn(async () => "new") })
      analyzer = createMockAnalyzer([
        { description: "Change", targetFiles: [], riskLevel: "low", evidence: [], relevanceScore: 0.8 },
      ])
      tracker = new UpstreamTracker(git, analyzer, {
        repos: [
          makeRepo({ name: "repo-a", lastKnownCommit: "old" }),
          makeRepo({ name: "repo-b", lastKnownCommit: "old" }),
        ],
      })

      const results = await tracker.checkAll()
      expect(results).toHaveLength(2)
      expect(tracker.drainIntents()).toHaveLength(2)
    })
  })
})
