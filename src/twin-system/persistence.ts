/**
 * PersistenceAdapter — SQLite storage for the twin-system.
 *
 * Persists:
 * - Slot states (active/standby)
 * - Evolution records (history)
 * - Circuit breaker state
 * - Evolution frequency per file (for SafetyGuard rate limiting)
 *
 * Uses better-sqlite3 (already a project dependency) via the shared db/client.
 */

import type {
  SlotId,
  SlotState,
  SlotStatus,
  EvolutionRecord,
  EvolutionAction,
} from "./types.js"
import type { EvolutionFrequencyStore } from "./safety-guard.js"

// ── Database Interface (for testability) ─────────────────────────────────────

export interface SqliteDb {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
}

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS twin_slots (
  id TEXT PRIMARY KEY CHECK(id IN ('a', 'b')),
  status TEXT NOT NULL DEFAULT 'standby',
  branch TEXT NOT NULL DEFAULT '',
  last_commit TEXT,
  current_intent_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS twin_evolution_records (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  action TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0,
  from_slot TEXT NOT NULL,
  to_slot TEXT NOT NULL,
  changed_files TEXT NOT NULL DEFAULT '[]',
  validation_result TEXT,
  confidence TEXT,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evo_records_intent
  ON twin_evolution_records(intent_id);
CREATE INDEX IF NOT EXISTS idx_evo_records_timestamp
  ON twin_evolution_records(timestamp);

CREATE TABLE IF NOT EXISTS twin_circuit_breaker (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  open INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  opened_at INTEGER
);

CREATE TABLE IF NOT EXISTS twin_evolution_frequency (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  evolved_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evo_freq_file_time
  ON twin_evolution_frequency(file_path, evolved_at);
`

// ── Row Types ────────────────────────────────────────────────────────────────

interface SlotRow {
  id: string
  status: string
  branch: string
  last_commit: string | null
  current_intent_id: string | null
  updated_at: number
}

interface RecordRow {
  id: string
  intent_id: string
  action: string
  success: number
  from_slot: string
  to_slot: string
  changed_files: string
  validation_result: string | null
  confidence: string | null
  timestamp: number
}

interface CircuitRow {
  id: number
  open: number
  reason: string | null
  opened_at: number | null
}

// ── PersistenceAdapter ───────────────────────────────────────────────────────

export class PersistenceAdapter implements EvolutionFrequencyStore {
  private db: SqliteDb

  constructor(db: SqliteDb) {
    this.db = db
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(SCHEMA_SQL)
    // Ensure circuit breaker row exists
    this.db
      .prepare(
        "INSERT OR IGNORE INTO twin_circuit_breaker (id, open) VALUES (1, 0)",
      )
      .run()
  }

  // ── Slot Persistence ─────────────────────────────────────────────────────

  saveSlot(slot: SlotState): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO twin_slots (id, status, branch, last_commit, current_intent_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        slot.id,
        slot.status,
        slot.branch,
        slot.lastCommit ?? null,
        slot.currentIntentId ?? null,
        slot.updatedAt,
      )
  }

  loadSlot(id: SlotId): SlotState | null {
    const row = this.db
      .prepare("SELECT * FROM twin_slots WHERE id = ?")
      .get(id) as SlotRow | undefined

    if (!row) return null

    return {
      id: row.id as SlotId,
      status: row.status as SlotStatus,
      branch: row.branch,
      lastCommit: row.last_commit ?? undefined,
      currentIntentId: row.current_intent_id ?? undefined,
      updatedAt: row.updated_at,
    }
  }

  loadAllSlots(): SlotState[] {
    const rows = this.db
      .prepare("SELECT * FROM twin_slots ORDER BY id")
      .all() as SlotRow[]

    return rows.map((row) => ({
      id: row.id as SlotId,
      status: row.status as SlotStatus,
      branch: row.branch,
      lastCommit: row.last_commit ?? undefined,
      currentIntentId: row.current_intent_id ?? undefined,
      updatedAt: row.updated_at,
    }))
  }

  // ── Evolution Record Persistence ─────────────────────────────────────────

  saveRecord(record: EvolutionRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO twin_evolution_records
         (id, intent_id, action, success, from_slot, to_slot, changed_files, validation_result, confidence, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.intentId,
        record.action,
        record.success ? 1 : 0,
        record.fromSlot,
        record.toSlot,
        JSON.stringify(record.changedFiles),
        record.validationResult
          ? JSON.stringify(record.validationResult)
          : null,
        record.confidence ? JSON.stringify(record.confidence) : null,
        record.timestamp,
      )
  }

  loadRecords(limit = 100): EvolutionRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM twin_evolution_records ORDER BY timestamp DESC LIMIT ?",
      )
      .all(limit) as RecordRow[]

    return rows.map((row) => this.rowToRecord(row))
  }

  loadRecordsByIntent(intentId: string): EvolutionRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM twin_evolution_records WHERE intent_id = ? ORDER BY timestamp",
      )
      .all(intentId) as RecordRow[]

    return rows.map((row) => this.rowToRecord(row))
  }

  private rowToRecord(row: RecordRow): EvolutionRecord {
    return {
      id: row.id,
      intentId: row.intent_id,
      action: row.action as EvolutionAction,
      success: row.success === 1,
      fromSlot: row.from_slot as SlotId,
      toSlot: row.to_slot as SlotId,
      changedFiles: JSON.parse(row.changed_files) as string[],
      validationResult: row.validation_result
        ? JSON.parse(row.validation_result)
        : undefined,
      confidence: row.confidence ? JSON.parse(row.confidence) : undefined,
      timestamp: row.timestamp,
    }
  }

  // ── Circuit Breaker Persistence ──────────────────────────────────────────

  saveCircuitState(state: {
    open: boolean
    reason?: string
    openedAt?: number
  }): void {
    this.db
      .prepare(
        "UPDATE twin_circuit_breaker SET open = ?, reason = ?, opened_at = ? WHERE id = 1",
      )
      .run(state.open ? 1 : 0, state.reason ?? null, state.openedAt ?? null)
  }

  loadCircuitState(): { open: boolean; reason?: string; openedAt?: number } {
    const row = this.db
      .prepare("SELECT * FROM twin_circuit_breaker WHERE id = 1")
      .get() as CircuitRow | undefined

    if (!row) return { open: false }

    return {
      open: row.open === 1,
      reason: row.reason ?? undefined,
      openedAt: row.opened_at ?? undefined,
    }
  }

  // ── Evolution Frequency (implements EvolutionFrequencyStore) ──────────────

  /**
   * Record that a file was evolved at a given timestamp.
   */
  recordEvolution(filePath: string, timestamp: number = Date.now()): void {
    this.db
      .prepare(
        "INSERT INTO twin_evolution_frequency (file_path, evolved_at) VALUES (?, ?)",
      )
      .run(filePath, timestamp)
  }

  /**
   * Get the number of evolutions for a file within the given window.
   * Implements EvolutionFrequencyStore interface.
   */
  getEvolutionCount(file: string, windowMs: number): number {
    const cutoff = Date.now() - windowMs
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM twin_evolution_frequency WHERE file_path = ? AND evolved_at >= ?",
      )
      .get(file, cutoff) as { cnt: number } | undefined

    return row?.cnt ?? 0
  }

  /**
   * Clean up old frequency records (older than windowMs).
   */
  cleanupFrequency(windowMs: number): number {
    const cutoff = Date.now() - windowMs
    const result = this.db
      .prepare(
        "DELETE FROM twin_evolution_frequency WHERE evolved_at < ?",
      )
      .run(cutoff)
    return result.changes
  }
}
