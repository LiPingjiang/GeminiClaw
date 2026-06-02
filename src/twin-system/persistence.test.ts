/**
 * Tests for PersistenceAdapter using in-memory SQLite.
 */
import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { PersistenceAdapter } from "./persistence.js"
import type { SlotState, EvolutionRecord } from "./types.js"

function createInMemoryDb() {
  const db = new Database(":memory:")
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  return db
}

describe("PersistenceAdapter", () => {
  let adapter: PersistenceAdapter

  beforeEach(() => {
    const db = createInMemoryDb()
    adapter = new PersistenceAdapter(db)
  })

  // ── Slot Persistence ───────────────────────────────────────────────────────

  describe("slot persistence", () => {
    it("saves and loads a slot", () => {
      const slot: SlotState = {
        id: "a",
        status: "active",
        branch: "main",
        lastCommit: "abc123",
        updatedAt: 1000,
      }
      adapter.saveSlot(slot)

      const loaded = adapter.loadSlot("a")
      expect(loaded).toEqual(slot)
    })

    it("returns null for non-existent slot", () => {
      expect(adapter.loadSlot("a")).toBeNull()
    })

    it("saves slot without optional fields", () => {
      const slot: SlotState = {
        id: "b",
        status: "standby",
        branch: "",
        updatedAt: 2000,
      }
      adapter.saveSlot(slot)

      const loaded = adapter.loadSlot("b")
      expect(loaded).toEqual({
        id: "b",
        status: "standby",
        branch: "",
        lastCommit: undefined,
        currentIntentId: undefined,
        updatedAt: 2000,
      })
    })

    it("overwrites existing slot on save", () => {
      adapter.saveSlot({
        id: "a",
        status: "active",
        branch: "main",
        updatedAt: 1000,
      })
      adapter.saveSlot({
        id: "a",
        status: "evolving",
        branch: "evolution/x",
        currentIntentId: "x",
        updatedAt: 2000,
      })

      const loaded = adapter.loadSlot("a")
      expect(loaded!.status).toBe("evolving")
      expect(loaded!.branch).toBe("evolution/x")
    })

    it("loads all slots", () => {
      adapter.saveSlot({ id: "a", status: "active", branch: "main", updatedAt: 1000 })
      adapter.saveSlot({ id: "b", status: "standby", branch: "", updatedAt: 1000 })

      const slots = adapter.loadAllSlots()
      expect(slots).toHaveLength(2)
      expect(slots[0].id).toBe("a")
      expect(slots[1].id).toBe("b")
    })
  })

  // ── Evolution Record Persistence ───────────────────────────────────────────

  describe("evolution record persistence", () => {
    const makeRecord = (overrides?: Partial<EvolutionRecord>): EvolutionRecord => ({
      id: "evo_001",
      intentId: "intent-1",
      action: "switch",
      success: true,
      fromSlot: "b",
      toSlot: "a",
      changedFiles: ["src/foo.ts", "src/bar.ts"],
      timestamp: 5000,
      ...overrides,
    })

    it("saves and loads records", () => {
      const record = makeRecord()
      adapter.saveRecord(record)

      const records = adapter.loadRecords()
      expect(records).toHaveLength(1)
      expect(records[0]).toEqual(record)
    })

    it("saves record with validation result and confidence", () => {
      const record = makeRecord({
        validationResult: {
          level: 1,
          passed: true,
          details: "{}",
          durationMs: 100,
        },
        confidence: {
          score: 0.85,
          reason: "Good",
          uncertainties: ["edge"],
        },
      })
      adapter.saveRecord(record)

      const loaded = adapter.loadRecords()
      expect(loaded[0].validationResult).toEqual(record.validationResult)
      expect(loaded[0].confidence).toEqual(record.confidence)
    })

    it("loads records ordered by timestamp DESC", () => {
      adapter.saveRecord(makeRecord({ id: "evo_1", timestamp: 1000 }))
      adapter.saveRecord(makeRecord({ id: "evo_2", timestamp: 3000 }))
      adapter.saveRecord(makeRecord({ id: "evo_3", timestamp: 2000 }))

      const records = adapter.loadRecords()
      expect(records.map((r) => r.id)).toEqual(["evo_2", "evo_3", "evo_1"])
    })

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        adapter.saveRecord(makeRecord({ id: `evo_${i}`, timestamp: i * 100 }))
      }
      const records = adapter.loadRecords(3)
      expect(records).toHaveLength(3)
    })

    it("loads records by intent ID", () => {
      adapter.saveRecord(makeRecord({ id: "e1", intentId: "A", timestamp: 1 }))
      adapter.saveRecord(makeRecord({ id: "e2", intentId: "B", timestamp: 2 }))
      adapter.saveRecord(makeRecord({ id: "e3", intentId: "A", timestamp: 3 }))

      const records = adapter.loadRecordsByIntent("A")
      expect(records).toHaveLength(2)
      expect(records.every((r) => r.intentId === "A")).toBe(true)
    })
  })

  // ── Circuit Breaker Persistence ────────────────────────────────────────────

  describe("circuit breaker persistence", () => {
    it("defaults to closed circuit", () => {
      const state = adapter.loadCircuitState()
      expect(state.open).toBe(false)
      expect(state.reason).toBeUndefined()
    })

    it("saves and loads open circuit", () => {
      adapter.saveCircuitState({
        open: true,
        reason: "Too many failures",
        openedAt: 9999,
      })

      const state = adapter.loadCircuitState()
      expect(state.open).toBe(true)
      expect(state.reason).toBe("Too many failures")
      expect(state.openedAt).toBe(9999)
    })

    it("can close circuit", () => {
      adapter.saveCircuitState({ open: true, reason: "err", openedAt: 1 })
      adapter.saveCircuitState({ open: false })

      const state = adapter.loadCircuitState()
      expect(state.open).toBe(false)
      expect(state.reason).toBeUndefined()
    })
  })

  // ── Evolution Frequency ────────────────────────────────────────────────────

  describe("evolution frequency", () => {
    it("records and counts evolutions", () => {
      const now = Date.now()
      adapter.recordEvolution("src/foo.ts", now - 1000)
      adapter.recordEvolution("src/foo.ts", now - 2000)
      adapter.recordEvolution("src/bar.ts", now - 500)

      // Window of 1 hour should include all
      const count = adapter.getEvolutionCount("src/foo.ts", 3600_000)
      expect(count).toBe(2)
    })

    it("respects time window", () => {
      const now = Date.now()
      adapter.recordEvolution("src/x.ts", now - 100_000) // recent
      adapter.recordEvolution("src/x.ts", now - 200_000) // recent
      adapter.recordEvolution("src/x.ts", now - 90_000_000) // old (25 hours ago)

      // 24h window = 86400000ms
      const count = adapter.getEvolutionCount("src/x.ts", 86_400_000)
      expect(count).toBe(2) // only recent 2
    })

    it("returns 0 for unknown files", () => {
      expect(adapter.getEvolutionCount("unknown.ts", 86_400_000)).toBe(0)
    })

    it("cleans up old records", () => {
      const now = Date.now()
      adapter.recordEvolution("src/a.ts", now - 100_000_000) // old
      adapter.recordEvolution("src/b.ts", now - 1000) // recent

      const deleted = adapter.cleanupFrequency(86_400_000)
      expect(deleted).toBe(1)

      // Recent one should still exist
      expect(adapter.getEvolutionCount("src/b.ts", 86_400_000)).toBe(1)
    })
  })
})
