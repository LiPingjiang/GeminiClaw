// src/evolution/db.test.ts
// Unit tests for EvolutionDB

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { tmpdir } from "os"
import { join } from "path"
import { randomUUID } from "crypto"
import { EvolutionDB } from "./db.js"
import type {
  Intent,
  TraceRecord,
  EvolutionRecord,
  SlotState,
  UpstreamCheck,
  PendingReview,
  ConversationSample,
  EvolutionPreview,
} from "./types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDbPath(): string {
  return join(tmpdir(), `evolution-test-${randomUUID()}.db`)
}

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  const now = Date.now()
  return {
    id: randomUUID(),
    type: "behavior_fix",
    description: "Fix silent failure on empty LLM response",
    targetFiles: ["src/providers/router.ts"],
    evidence: ["3 failures observed in last 24h"],
    riskLevel: "low",
    requiresHumanApproval: false,
    status: "pending",
    whyNow: "High failure rate detected",
    discoveredContext: "User was debugging deployment",
    snoozeCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeTrace(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: randomUUID(),
    sessionId: "session-1",
    toolSequence: ["read_file", "write_file"],
    hadFailure: false,
    messageCount: 3,
    responseLength: 120,
    recordedAt: Date.now(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EvolutionDB", () => {
  let db: EvolutionDB

  beforeEach(() => {
    db = new EvolutionDB(tmpDbPath())
  })

  afterEach(() => {
    db.close()
  })

  // -------------------------------------------------------------------------
  // Intents
  // -------------------------------------------------------------------------

  describe("intents", () => {
    it("inserts and retrieves an intent", () => {
      const intent = makeIntent()
      db.insertIntent(intent)

      const fetched = db.getIntent(intent.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.id).toBe(intent.id)
      expect(fetched!.description).toBe(intent.description)
      expect(fetched!.targetFiles).toEqual(["src/providers/router.ts"])
      expect(fetched!.evidence).toEqual(["3 failures observed in last 24h"])
      expect(fetched!.requiresHumanApproval).toBe(false)
      expect(fetched!.status).toBe("pending")
    })

    it("returns null for unknown intent id", () => {
      expect(db.getIntent("nonexistent")).toBeNull()
    })

    it("lists all intents", () => {
      db.insertIntent(makeIntent({ id: "i1", status: "pending" }))
      db.insertIntent(makeIntent({ id: "i2", status: "applied" }))
      db.insertIntent(makeIntent({ id: "i3", status: "pending" }))

      const all = db.listIntents()
      expect(all).toHaveLength(3)
    })

    it("lists intents filtered by status", () => {
      db.insertIntent(makeIntent({ id: "i1", status: "pending" }))
      db.insertIntent(makeIntent({ id: "i2", status: "applied" }))
      db.insertIntent(makeIntent({ id: "i3", status: "pending" }))

      const pending = db.listIntents({ status: "pending" })
      expect(pending).toHaveLength(2)
      expect(pending.every(i => i.status === "pending")).toBe(true)

      const applied = db.listIntents({ status: "applied" })
      expect(applied).toHaveLength(1)
      expect(applied[0].id).toBe("i2")
    })

    it("updates intent status", () => {
      const intent = makeIntent({ status: "pending" })
      db.insertIntent(intent)

      db.updateIntentStatus(intent.id, "in_progress")

      const updated = db.getIntent(intent.id)
      expect(updated!.status).toBe("in_progress")
    })

    it("preserves snoozedUntil when set", () => {
      const snoozedUntil = Date.now() + 86400000
      const intent = makeIntent({ snoozedUntil, status: "snoozed" })
      db.insertIntent(intent)

      const fetched = db.getIntent(intent.id)
      expect(fetched!.snoozedUntil).toBe(snoozedUntil)
    })

    it("preserves snoozedUntil as undefined when not set", () => {
      const intent = makeIntent()
      db.insertIntent(intent)

      const fetched = db.getIntent(intent.id)
      expect(fetched!.snoozedUntil).toBeUndefined()
    })

    it("handles requiresHumanApproval=true correctly", () => {
      const intent = makeIntent({ requiresHumanApproval: true })
      db.insertIntent(intent)

      const fetched = db.getIntent(intent.id)
      expect(fetched!.requiresHumanApproval).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Traces
  // -------------------------------------------------------------------------

  describe("traces", () => {
    it("inserts and retrieves recent traces", () => {
      const t1 = makeTrace({ recordedAt: Date.now() - 2000 })
      const t2 = makeTrace({ recordedAt: Date.now() - 1000 })
      const t3 = makeTrace({ recordedAt: Date.now() })
      db.insertTrace(t1)
      db.insertTrace(t2)
      db.insertTrace(t3)

      // getRecentTraces returns newest first (DESC order)
      const recent = db.getRecentTraces(2)
      expect(recent).toHaveLength(2)
      expect(recent[0].id).toBe(t3.id)
      expect(recent[1].id).toBe(t2.id)
    })

    it("counts traces", () => {
      expect(db.countTraces()).toBe(0)
      db.insertTrace(makeTrace())
      db.insertTrace(makeTrace())
      expect(db.countTraces()).toBe(2)
    })

    it("calculates failure rate correctly", () => {
      const now = Date.now()
      db.insertTrace(makeTrace({ hadFailure: false, recordedAt: now - 1000 }))
      db.insertTrace(makeTrace({ hadFailure: true, recordedAt: now - 500 }))
      db.insertTrace(makeTrace({ hadFailure: true, recordedAt: now - 100 }))

      const rate = db.getFailureRate(5000)
      expect(rate).toBeCloseTo(2 / 3, 5)
    })

    it("returns 0 failure rate when no traces in window", () => {
      const rate = db.getFailureRate(1000)
      expect(rate).toBe(0)
    })

    it("excludes traces outside the time window", () => {
      const now = Date.now()
      // old trace (outside 1s window)
      db.insertTrace(makeTrace({ hadFailure: true, recordedAt: now - 10000 }))
      // recent trace (inside 1s window)
      db.insertTrace(makeTrace({ hadFailure: false, recordedAt: now - 100 }))

      const rate = db.getFailureRate(1000)
      expect(rate).toBe(0)  // only 1 trace in window, no failures
    })

    it("preserves toolSequence array", () => {
      const trace = makeTrace({ toolSequence: ["read_file", "bash", "write_file"] })
      db.insertTrace(trace)
      const fetched = db.getRecentTraces(1)[0]
      expect(fetched.toolSequence).toEqual(["read_file", "bash", "write_file"])
    })
  })

  // -------------------------------------------------------------------------
  // Evolution History
  // -------------------------------------------------------------------------

  describe("evolution_history", () => {
    it("inserts and retrieves evolution records", () => {
      const record: Omit<EvolutionRecord, "id"> = {
        intentId: "intent-1",
        type: "switch",
        fromSlot: "a",
        toSlot: "b",
        changedFiles: ["src/providers/router.ts"],
        recordedAt: Date.now(),
      }
      db.insertEvolutionRecord(record)

      const last = db.getLastEvolutionRecord()
      expect(last).not.toBeNull()
      expect(last!.intentId).toBe("intent-1")
      expect(last!.type).toBe("switch")
      expect(last!.changedFiles).toEqual(["src/providers/router.ts"])
    })

    it("returns null when no history", () => {
      expect(db.getLastEvolutionRecord()).toBeNull()
    })

    it("lists history in descending order", () => {
      const now = Date.now()
      db.insertEvolutionRecord({
        intentId: "i1", type: "switch", fromSlot: "a", toSlot: "b",
        changedFiles: [], recordedAt: now - 2000,
      })
      db.insertEvolutionRecord({
        intentId: "i2", type: "rollback", fromSlot: "b", toSlot: "a",
        changedFiles: [], recordedAt: now - 1000,
      })

      const history = db.listEvolutionHistory()
      expect(history).toHaveLength(2)
      expect(history[0].intentId).toBe("i2")  // most recent first
      expect(history[1].intentId).toBe("i1")
    })

    it("respects limit in listEvolutionHistory", () => {
      for (let i = 0; i < 5; i++) {
        db.insertEvolutionRecord({
          intentId: `i${i}`, type: "switch", fromSlot: "a", toSlot: "b",
          changedFiles: [], recordedAt: Date.now() + i,
        })
      }
      const history = db.listEvolutionHistory(3)
      expect(history).toHaveLength(3)
    })
  })

  // -------------------------------------------------------------------------
  // Slot State
  // -------------------------------------------------------------------------

  describe("slot_state", () => {
    it("returns null for unknown slot", () => {
      expect(db.getSlotState("a")).toBeNull()
    })

    it("upserts and retrieves slot state", () => {
      const state: SlotState = {
        slotId: "a",
        role: "active",
        buildHash: "abc123",
        builtAt: Date.now(),
        lastActivatedAt: Date.now(),
      }
      db.upsertSlotState(state)

      const fetched = db.getSlotState("a")
      expect(fetched).not.toBeNull()
      expect(fetched!.role).toBe("active")
      expect(fetched!.buildHash).toBe("abc123")
    })

    it("updates existing slot state on upsert", () => {
      db.upsertSlotState({
        slotId: "b",
        role: "standby",
        buildHash: "old-hash",
        builtAt: 0,
      })
      db.upsertSlotState({
        slotId: "b",
        role: "active",
        buildHash: "new-hash",
        builtAt: Date.now(),
        lastActivatedAt: Date.now(),
      })

      const fetched = db.getSlotState("b")
      expect(fetched!.role).toBe("active")
      expect(fetched!.buildHash).toBe("new-hash")
    })

    it("preserves lastActivatedAt as undefined when not set", () => {
      db.upsertSlotState({
        slotId: "a",
        role: "standby",
        buildHash: "",
        builtAt: 0,
      })
      const fetched = db.getSlotState("a")
      expect(fetched!.lastActivatedAt).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Pending Reviews
  // -------------------------------------------------------------------------

  describe("pending_reviews", () => {
    it("inserts and retrieves a pending review", () => {
      const review: PendingReview = {
        intentId: "intent-1",
        description: "Optimize prompt caching",
        targetFiles: ["src/providers/anthropic.ts"],
        riskLevel: "medium",
        status: "pending",
        requestedAt: Date.now(),
      }
      db.insertPendingReview(review)

      const fetched = db.getPendingReview("intent-1")
      expect(fetched).not.toBeNull()
      expect(fetched!.description).toBe("Optimize prompt caching")
      expect(fetched!.status).toBe("pending")
      expect(fetched!.reviewer).toBeUndefined()
    })

    it("returns null for unknown intentId", () => {
      expect(db.getPendingReview("nonexistent")).toBeNull()
    })

    it("updates a pending review", () => {
      db.insertPendingReview({
        intentId: "intent-2",
        description: "Risky change",
        targetFiles: [],
        riskLevel: "high",
        status: "pending",
        requestedAt: Date.now(),
      })

      const resolvedAt = Date.now()
      db.updatePendingReview("intent-2", {
        status: "approved",
        reviewer: "lipingjiang",
        comment: "Looks good",
        resolvedAt,
      })

      const updated = db.getPendingReview("intent-2")
      expect(updated!.status).toBe("approved")
      expect(updated!.reviewer).toBe("lipingjiang")
      expect(updated!.comment).toBe("Looks good")
      expect(updated!.resolvedAt).toBe(resolvedAt)
    })

    it("no-ops updatePendingReview with empty patch", () => {
      db.insertPendingReview({
        intentId: "intent-3",
        description: "Test",
        targetFiles: [],
        riskLevel: "low",
        status: "pending",
        requestedAt: Date.now(),
      })
      // Should not throw
      db.updatePendingReview("intent-3", {})
      const fetched = db.getPendingReview("intent-3")
      expect(fetched!.status).toBe("pending")
    })
  })

  // -------------------------------------------------------------------------
  // Upstream Checks
  // -------------------------------------------------------------------------

  describe("upstream_checks", () => {
    it("returns null when no checks recorded", () => {
      expect(db.getLastUpstreamCheck()).toBeNull()
    })

    it("inserts and retrieves the latest upstream check", () => {
      const check: Omit<UpstreamCheck, "id"> = {
        newCommits: ["abc123", "def456"],
        changedFiles: ["src/providers/anthropic.ts"],
        addedLines: 42,
        removedLines: 10,
        checkedAt: Date.now(),
        intentGenerated: false,
      }
      db.insertUpstreamCheck(check)

      const fetched = db.getLastUpstreamCheck()
      expect(fetched).not.toBeNull()
      expect(fetched!.newCommits).toEqual(["abc123", "def456"])
      expect(fetched!.addedLines).toBe(42)
      expect(fetched!.intentGenerated).toBe(false)
    })

    it("returns the most recent check when multiple exist", () => {
      const now = Date.now()
      db.insertUpstreamCheck({
        newCommits: ["old"], changedFiles: [], addedLines: 1, removedLines: 0,
        checkedAt: now - 1000, intentGenerated: false,
      })
      db.insertUpstreamCheck({
        newCommits: ["new"], changedFiles: [], addedLines: 5, removedLines: 2,
        checkedAt: now, intentGenerated: true,
      })

      const latest = db.getLastUpstreamCheck()
      expect(latest!.newCommits).toEqual(["new"])
      expect(latest!.intentGenerated).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // ConversationSample CRUD
  // -------------------------------------------------------------------------

  describe("ConversationSample CRUD", () => {
    it("inserts and lists conversation samples", () => {
      const db = new EvolutionDB(":memory:")
      db.insertConversationSample({
        id: "s1",
        sessionId: "sess-1",
        userMessage: "hello",
        agentReply: "hi there",
        toolSequence: ["tool_a"],
        hadFailure: false,
        recordedAt: Date.now(),
      })
      const samples = db.listConversationSamples()
      expect(samples).toHaveLength(1)
      expect(samples[0].userMessage).toBe("hello")
      expect(samples[0].toolSequence).toEqual(["tool_a"])
    })

    it("prunes to 500 samples on insert", () => {
      const db = new EvolutionDB(":memory:")
      for (let i = 0; i < 502; i++) {
        db.insertConversationSample({
          id: `s${i}`,
          sessionId: "sess-1",
          userMessage: `msg ${i}`,
          agentReply: `reply ${i}`,
          toolSequence: [],
          hadFailure: false,
          recordedAt: Date.now() + i,
        })
      }
      expect(db.countConversationSamples()).toBe(500)
    })
  })

  // -------------------------------------------------------------------------
  // EvolutionPreview CRUD
  // -------------------------------------------------------------------------

  describe("EvolutionPreview CRUD", () => {
    it("inserts and lists previews by intentId", () => {
      const db = new EvolutionDB(":memory:")
      db.insertEvolutionPreview({
        id: "p1",
        intentId: "intent-1",
        sampleId: "s1",
        userMessage: "what is X?",
        beforeReply: "old answer",
        afterReply: "new better answer",
        summary: "improved clarity",
        generatedAt: Date.now(),
      })
      const previews = db.listEvolutionPreviews("intent-1")
      expect(previews).toHaveLength(1)
      expect(previews[0].afterReply).toBe("new better answer")
      expect(db.hasEvolutionPreview("intent-1")).toBe(true)
      expect(db.hasEvolutionPreview("intent-999")).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles empty arrays correctly", () => {
      const intent = makeIntent({ targetFiles: [], evidence: [] })
      db.insertIntent(intent)
      const fetched = db.getIntent(intent.id)
      expect(fetched!.targetFiles).toEqual([])
      expect(fetched!.evidence).toEqual([])
    })

    it("handles multiple DB instances on different paths (isolation)", () => {
      const db2 = new EvolutionDB(tmpDbPath())
      try {
        db.insertIntent(makeIntent({ id: "only-in-db1" }))
        expect(db.getIntent("only-in-db1")).not.toBeNull()
        expect(db2.getIntent("only-in-db1")).toBeNull()
      } finally {
        db2.close()
      }
    })
  })
})
