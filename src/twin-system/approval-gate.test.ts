/**
 * Tests for ApprovalGate — human approval workflow for evolution intents.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { ApprovalGate } from "./approval-gate.js"
import type { EvolutionIntent } from "./types.js"

function makeIntent(overrides?: Partial<EvolutionIntent>): EvolutionIntent {
  return {
    id: "test-intent-1",
    type: "behavior_fix",
    description: "Fix short responses",
    targetFiles: ["src/server/routes/chat.ts"],
    evidence: ["80% short response rate"],
    riskLevel: "medium",
    requiresHumanApproval: true,
    createdAt: Date.now(),
    ...overrides,
  }
}

describe("ApprovalGate", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Auto-approval Tests ──────────────────────────────────────────────────

  describe("auto-approval", () => {
    it("auto-approves low-risk intents by default", async () => {
      const gate = new ApprovalGate({ autoApproveRiskLevels: ["low"] })
      const intent = makeIntent({ riskLevel: "low" })

      const result = await gate.requestApproval(intent, "summary")
      expect(result).toBe(true)
      expect(gate.pendingCount).toBe(0) // should not be queued
    })

    it("auto-approves when riskLevel is in configured list", async () => {
      const gate = new ApprovalGate({ autoApproveRiskLevels: ["low", "medium"] })
      const intent = makeIntent({ riskLevel: "medium" })

      const result = await gate.requestApproval(intent, "summary")
      expect(result).toBe(true)
    })

    it("does NOT auto-approve high-risk when only low is configured", async () => {
      const gate = new ApprovalGate({
        autoApproveRiskLevels: ["low"],
        approvalTimeoutMs: 5000,
      })
      const intent = makeIntent({ riskLevel: "high" })

      // This will block until timeout or manual action
      const promise = gate.requestApproval(intent, "high risk stuff")
      expect(gate.pendingCount).toBe(1)

      // Advance time to trigger timeout
      vi.advanceTimersByTime(5000)
      const result = await promise
      expect(result).toBe(false) // auto-rejected on timeout
    })
  })

  // ── Manual Approval Tests ────────────────────────────────────────────────

  describe("manual approve/reject", () => {
    it("approves a pending request", async () => {
      const gate = new ApprovalGate({
        autoApproveRiskLevels: [],
        approvalTimeoutMs: 60000,
      })
      const intent = makeIntent({ riskLevel: "medium" })

      const promise = gate.requestApproval(intent, "needs review")
      expect(gate.pendingCount).toBe(1)

      const pending = gate.listPending()
      expect(pending).toHaveLength(1)
      expect(pending[0].intentId).toBe("test-intent-1")
      expect(pending[0].status).toBe("pending")

      // Approve it
      const approved = gate.approve(pending[0].id, "admin")
      expect(approved).toBe(true)

      const result = await promise
      expect(result).toBe(true)
      expect(gate.pendingCount).toBe(0)
    })

    it("rejects a pending request", async () => {
      const gate = new ApprovalGate({
        autoApproveRiskLevels: [],
        approvalTimeoutMs: 60000,
      })
      const intent = makeIntent({ riskLevel: "high" })

      const promise = gate.requestApproval(intent, "dangerous change")

      const pending = gate.listPending()
      const rejected = gate.reject(pending[0].id, "reviewer")
      expect(rejected).toBe(true)

      const result = await promise
      expect(result).toBe(false)
    })

    it("returns false when approving non-existent request", () => {
      const gate = new ApprovalGate()
      expect(gate.approve("nonexistent")).toBe(false)
    })

    it("returns false when rejecting non-existent request", () => {
      const gate = new ApprovalGate()
      expect(gate.reject("nonexistent")).toBe(false)
    })

    it("cannot approve already-approved request", async () => {
      const gate = new ApprovalGate({
        autoApproveRiskLevels: [],
        approvalTimeoutMs: 60000,
      })
      const intent = makeIntent({ riskLevel: "medium" })

      const promise = gate.requestApproval(intent, "review me")
      const pending = gate.listPending()
      const id = pending[0].id

      gate.approve(id)
      await promise

      // Second approve should fail
      expect(gate.approve(id)).toBe(false)
    })
  })

  // ── Timeout Tests ────────────────────────────────────────────────────────

  describe("timeout behavior", () => {
    it("auto-rejects after timeout", async () => {
      const gate = new ApprovalGate({
        autoApproveRiskLevels: [],
        approvalTimeoutMs: 3000,
      })
      const intent = makeIntent({ riskLevel: "high" })

      const promise = gate.requestApproval(intent, "will timeout")
      expect(gate.pendingCount).toBe(1)

      vi.advanceTimersByTime(3000)
      const result = await promise
      expect(result).toBe(false)
      expect(gate.pendingCount).toBe(0)
    })

    it("does not expire if approved before timeout", async () => {
      const gate = new ApprovalGate({
        autoApproveRiskLevels: [],
        approvalTimeoutMs: 10000,
      })
      const intent = makeIntent({ riskLevel: "medium" })

      const promise = gate.requestApproval(intent, "quick approval")
      const pending = gate.listPending()

      // Approve after 2 seconds (before 10s timeout)
      vi.advanceTimersByTime(2000)
      gate.approve(pending[0].id)

      const result = await promise
      expect(result).toBe(true)

      // Advance past timeout — should not cause issues
      vi.advanceTimersByTime(10000)
      expect(gate.pendingCount).toBe(0)
    })
  })

  // ── Queue Limit Tests ────────────────────────────────────────────────────

  describe("queue limit", () => {
    it("rejects when queue is full", async () => {
      const gate = new ApprovalGate({
        autoApproveRiskLevels: [],
        maxPendingRequests: 2,
        approvalTimeoutMs: 60000,
      })

      // Fill the queue
      gate.requestApproval(makeIntent({ id: "i1", riskLevel: "medium" }), "s1")
      gate.requestApproval(makeIntent({ id: "i2", riskLevel: "medium" }), "s2")
      expect(gate.pendingCount).toBe(2)

      // Third should be rejected immediately
      const result = await gate.requestApproval(
        makeIntent({ id: "i3", riskLevel: "medium" }),
        "s3",
      )
      expect(result).toBe(false)
      expect(gate.pendingCount).toBe(2) // still 2, not 3
    })
  })

  // ── Listing & Inspection ─────────────────────────────────────────────────

  describe("listing", () => {
    it("lists multiple pending requests", () => {
      const gate = new ApprovalGate({
        autoApproveRiskLevels: [],
        approvalTimeoutMs: 60000,
      })

      gate.requestApproval(makeIntent({ id: "a", riskLevel: "medium" }), "s1")
      gate.requestApproval(makeIntent({ id: "b", riskLevel: "high" }), "s2")

      const pending = gate.listPending()
      expect(pending).toHaveLength(2)
      expect(pending[0].intentId).toBe("a")
      expect(pending[1].intentId).toBe("b")
    })

    it("expireStale removes expired items from listing", () => {
      const gate = new ApprovalGate({
        autoApproveRiskLevels: [],
        approvalTimeoutMs: 1000,
      })

      gate.requestApproval(makeIntent({ id: "x", riskLevel: "high" }), "sx")

      vi.advanceTimersByTime(1500)

      const pending = gate.listPending()
      expect(pending).toHaveLength(0)
    })
  })
})
