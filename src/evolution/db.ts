// src/evolution/db.ts
// SQLite data layer for the Evolution Engine
// Uses better-sqlite3 (synchronous API) for simplicity and reliability.

import Database from "better-sqlite3"
import { mkdirSync } from "fs"
import { dirname } from "path"
import type {
  Intent,
  IntentStatus,
  TraceRecord,
  EvolutionRecord,
  SlotId,
  SlotState,
  UpstreamCheck,
  PendingReview,
} from "./types.js"

// ---------------------------------------------------------------------------
// Helpers: JSON encode/decode arrays
// ---------------------------------------------------------------------------

function encodeArr(arr: string[]): string {
  return JSON.stringify(arr)
}

function decodeArr(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    return JSON.parse(json) as string[]
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Row types (raw DB rows before mapping)
// ---------------------------------------------------------------------------

interface IntentRow {
  id: string
  type: string
  description: string
  target_files: string
  evidence: string
  risk_level: string
  requires_human_approval: number
  status: string
  why_now: string
  discovered_context: string
  snoozed_until: number | null
  snooze_count: number
  created_at: number
  updated_at: number
}

interface TraceRow {
  id: string
  session_id: string
  tool_sequence: string
  had_failure: number
  message_count: number
  recorded_at: number
}

interface EvolutionRow {
  id: number
  intent_id: string
  type: string
  from_slot: string
  to_slot: string
  changed_files: string
  recorded_at: number
}

interface SlotRow {
  slot_id: string
  role: string
  build_hash: string
  built_at: number
  last_activated_at: number | null
}

interface UpstreamCheckRow {
  id: number
  new_commits: string
  changed_files: string
  added_lines: number
  removed_lines: number
  checked_at: number
  intent_generated: number
}

interface PendingReviewRow {
  intent_id: string
  description: string
  target_files: string
  risk_level: string
  status: string
  reviewer: string | null
  comment: string | null
  requested_at: number
  resolved_at: number | null
}

// ---------------------------------------------------------------------------
// Mappers: DB row → domain type
// ---------------------------------------------------------------------------

function rowToIntent(row: IntentRow): Intent {
  return {
    id: row.id,
    type: row.type as Intent["type"],
    description: row.description,
    targetFiles: decodeArr(row.target_files),
    evidence: decodeArr(row.evidence),
    riskLevel: row.risk_level as Intent["riskLevel"],
    requiresHumanApproval: row.requires_human_approval === 1,
    status: row.status as IntentStatus,
    whyNow: row.why_now,
    discoveredContext: row.discovered_context,
    snoozedUntil: row.snoozed_until ?? undefined,
    snoozeCount: row.snooze_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToTrace(row: TraceRow): TraceRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    toolSequence: decodeArr(row.tool_sequence),
    hadFailure: row.had_failure === 1,
    messageCount: row.message_count,
    recordedAt: row.recorded_at,
  }
}

function rowToEvolution(row: EvolutionRow): EvolutionRecord {
  return {
    id: row.id,
    intentId: row.intent_id,
    type: row.type as EvolutionRecord["type"],
    fromSlot: row.from_slot,
    toSlot: row.to_slot,
    changedFiles: decodeArr(row.changed_files),
    recordedAt: row.recorded_at,
  }
}

function rowToSlotState(row: SlotRow): SlotState {
  return {
    slotId: row.slot_id as SlotId,
    role: row.role as SlotState["role"],
    buildHash: row.build_hash,
    builtAt: row.built_at,
    lastActivatedAt: row.last_activated_at ?? undefined,
  }
}

function rowToUpstreamCheck(row: UpstreamCheckRow): UpstreamCheck {
  return {
    id: row.id,
    newCommits: decodeArr(row.new_commits),
    changedFiles: decodeArr(row.changed_files),
    addedLines: row.added_lines,
    removedLines: row.removed_lines,
    checkedAt: row.checked_at,
    intentGenerated: row.intent_generated === 1,
  }
}

function rowToPendingReview(row: PendingReviewRow): PendingReview {
  return {
    intentId: row.intent_id,
    description: row.description,
    targetFiles: decodeArr(row.target_files),
    riskLevel: row.risk_level as PendingReview["riskLevel"],
    status: row.status as PendingReview["status"],
    reviewer: row.reviewer ?? undefined,
    comment: row.comment ?? undefined,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at ?? undefined,
  }
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const DDL = `
CREATE TABLE IF NOT EXISTS intents (
  id                       TEXT PRIMARY KEY,
  type                     TEXT NOT NULL,
  description              TEXT NOT NULL,
  target_files             TEXT NOT NULL DEFAULT '[]',
  evidence                 TEXT NOT NULL DEFAULT '[]',
  risk_level               TEXT NOT NULL,
  requires_human_approval  INTEGER NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL DEFAULT 'pending',
  why_now                  TEXT NOT NULL DEFAULT '',
  discovered_context       TEXT NOT NULL DEFAULT '',
  snoozed_until            INTEGER,
  snooze_count             INTEGER NOT NULL DEFAULT 0,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
CREATE INDEX IF NOT EXISTS idx_intents_created_at ON intents(created_at);

CREATE TABLE IF NOT EXISTS traces (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  tool_sequence  TEXT NOT NULL DEFAULT '[]',
  had_failure    INTEGER NOT NULL DEFAULT 0,
  message_count  INTEGER NOT NULL DEFAULT 0,
  recorded_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_traces_recorded_at ON traces(recorded_at);
CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);

CREATE TABLE IF NOT EXISTS evolution_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id      TEXT NOT NULL,
  type           TEXT NOT NULL,
  from_slot      TEXT NOT NULL,
  to_slot        TEXT NOT NULL,
  changed_files  TEXT NOT NULL DEFAULT '[]',
  recorded_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evolution_recorded_at ON evolution_history(recorded_at);

CREATE TABLE IF NOT EXISTS slot_state (
  slot_id            TEXT PRIMARY KEY,
  role               TEXT NOT NULL,
  build_hash         TEXT NOT NULL DEFAULT '',
  built_at           INTEGER NOT NULL DEFAULT 0,
  last_activated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS upstream_checks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  new_commits       TEXT NOT NULL DEFAULT '[]',
  changed_files     TEXT NOT NULL DEFAULT '[]',
  added_lines       INTEGER NOT NULL DEFAULT 0,
  removed_lines     INTEGER NOT NULL DEFAULT 0,
  checked_at        INTEGER NOT NULL,
  intent_generated  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pending_reviews (
  intent_id     TEXT PRIMARY KEY,
  description   TEXT NOT NULL,
  target_files  TEXT NOT NULL DEFAULT '[]',
  risk_level    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  reviewer      TEXT,
  comment       TEXT,
  requested_at  INTEGER NOT NULL,
  resolved_at   INTEGER
);
`

// ---------------------------------------------------------------------------
// EvolutionDB
// ---------------------------------------------------------------------------

export class EvolutionDB {
  private db: Database.Database

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma("journal_mode = WAL")
    this.db.pragma("foreign_keys = ON")
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(DDL)
  }

  // -------------------------------------------------------------------------
  // Intents
  // -------------------------------------------------------------------------

  insertIntent(intent: Intent): void {
    this.db.prepare(`
      INSERT INTO intents (
        id, type, description, target_files, evidence,
        risk_level, requires_human_approval, status,
        why_now, discovered_context, snoozed_until, snooze_count,
        created_at, updated_at
      ) VALUES (
        @id, @type, @description, @targetFiles, @evidence,
        @riskLevel, @requiresHumanApproval, @status,
        @whyNow, @discoveredContext, @snoozedUntil, @snoozeCount,
        @createdAt, @updatedAt
      )
    `).run({
      id: intent.id,
      type: intent.type,
      description: intent.description,
      targetFiles: encodeArr(intent.targetFiles),
      evidence: encodeArr(intent.evidence),
      riskLevel: intent.riskLevel,
      requiresHumanApproval: intent.requiresHumanApproval ? 1 : 0,
      status: intent.status,
      whyNow: intent.whyNow,
      discoveredContext: intent.discoveredContext,
      snoozedUntil: intent.snoozedUntil ?? null,
      snoozeCount: intent.snoozeCount,
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
    })
  }

  getIntent(id: string): Intent | null {
    const row = this.db.prepare(
      "SELECT * FROM intents WHERE id = ?"
    ).get(id) as IntentRow | undefined
    return row ? rowToIntent(row) : null
  }

  listIntents(filter?: { status?: IntentStatus }): Intent[] {
    if (filter?.status) {
      const rows = this.db.prepare(
        "SELECT * FROM intents WHERE status = ? ORDER BY created_at ASC"
      ).all(filter.status) as IntentRow[]
      return rows.map(rowToIntent)
    }
    const rows = this.db.prepare(
      "SELECT * FROM intents ORDER BY created_at ASC"
    ).all() as IntentRow[]
    return rows.map(rowToIntent)
  }

  /**
   * Check if a pending intent with the exact same description already exists.
   * Used by IntentEngine to avoid duplicate intent generation.
   */
  hasPendingIntentWithDescription(description: string): boolean {
    const row = this.db
      .prepare(
        `SELECT id FROM intents WHERE status = 'pending' AND description = ? LIMIT 1`
      )
      .get(description)
    return row !== undefined
  }

  updateIntentStatus(id: string, status: IntentStatus): void {
    this.db.prepare(
      "UPDATE intents SET status = ?, updated_at = ? WHERE id = ?"
    ).run(status, Date.now(), id)
  }

  // -------------------------------------------------------------------------
  // Traces
  // -------------------------------------------------------------------------

  insertTrace(trace: TraceRecord): void {
    this.db.prepare(`
      INSERT INTO traces (id, session_id, tool_sequence, had_failure, message_count, recorded_at)
      VALUES (@id, @sessionId, @toolSequence, @hadFailure, @messageCount, @recordedAt)
    `).run({
      id: trace.id,
      sessionId: trace.sessionId,
      toolSequence: encodeArr(trace.toolSequence),
      hadFailure: trace.hadFailure ? 1 : 0,
      messageCount: trace.messageCount,
      recordedAt: trace.recordedAt,
    })
  }

  getRecentTraces(limit: number): TraceRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM traces ORDER BY recorded_at DESC LIMIT ?"
    ).all(limit) as TraceRow[]
    return rows.map(rowToTrace)
  }

  countTraces(): number {
    const result = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM traces"
    ).get() as { cnt: number }
    return result.cnt
  }

  /** Returns the failure rate (0-1) within the given time window (ms). */
  getFailureRate(windowMs: number): number {
    const since = Date.now() - windowMs
    const result = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(had_failure) as failures
      FROM traces
      WHERE recorded_at >= ?
    `).get(since) as { total: number; failures: number | null }

    if (!result.total) return 0
    return (result.failures ?? 0) / result.total
  }

  // -------------------------------------------------------------------------
  // Evolution History
  // -------------------------------------------------------------------------

  insertEvolutionRecord(record: Omit<EvolutionRecord, "id">): void {
    this.db.prepare(`
      INSERT INTO evolution_history (intent_id, type, from_slot, to_slot, changed_files, recorded_at)
      VALUES (@intentId, @type, @fromSlot, @toSlot, @changedFiles, @recordedAt)
    `).run({
      intentId: record.intentId,
      type: record.type,
      fromSlot: record.fromSlot,
      toSlot: record.toSlot,
      changedFiles: encodeArr(record.changedFiles),
      recordedAt: record.recordedAt,
    })
  }

  getLastEvolutionRecord(): EvolutionRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM evolution_history ORDER BY recorded_at DESC LIMIT 1"
    ).get() as EvolutionRow | undefined
    return row ? rowToEvolution(row) : null
  }

  /**
   * Returns the number of evolution records (switches) that touched the given file
   * within the given time window (ms). Used by CircuitBreaker frequency limiting.
   */
  getEvolutionCountForFile(file: string, windowMs: number): number {
    const since = Date.now() - windowMs
    const rows = this.db.prepare(`
      SELECT changed_files FROM evolution_history
      WHERE type = 'switch' AND recorded_at >= ?
    `).all(since) as Array<{ changed_files: string }>

    let count = 0
    for (const row of rows) {
      const files = decodeArr(row.changed_files)
      if (files.some(f => f === file || f.startsWith(file) || file.startsWith(f))) {
        count++
      }
    }
    return count
  }

  listEvolutionHistory(limit = 20): EvolutionRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM evolution_history ORDER BY recorded_at DESC LIMIT ?"
    ).all(limit) as EvolutionRow[]
    return rows.map(rowToEvolution)
  }

  // -------------------------------------------------------------------------
  // Slot State
  // -------------------------------------------------------------------------

  getSlotState(slotId: SlotId): SlotState | null {
    const row = this.db.prepare(
      "SELECT * FROM slot_state WHERE slot_id = ?"
    ).get(slotId) as SlotRow | undefined
    return row ? rowToSlotState(row) : null
  }

  upsertSlotState(state: SlotState): void {
    this.db.prepare(`
      INSERT INTO slot_state (slot_id, role, build_hash, built_at, last_activated_at)
      VALUES (@slotId, @role, @buildHash, @builtAt, @lastActivatedAt)
      ON CONFLICT(slot_id) DO UPDATE SET
        role = excluded.role,
        build_hash = excluded.build_hash,
        built_at = excluded.built_at,
        last_activated_at = excluded.last_activated_at
    `).run({
      slotId: state.slotId,
      role: state.role,
      buildHash: state.buildHash,
      builtAt: state.builtAt,
      lastActivatedAt: state.lastActivatedAt ?? null,
    })
  }

  // -------------------------------------------------------------------------
  // Pending Reviews
  // -------------------------------------------------------------------------

  insertPendingReview(review: PendingReview): void {
    this.db.prepare(`
      INSERT INTO pending_reviews (
        intent_id, description, target_files, risk_level,
        status, reviewer, comment, requested_at, resolved_at
      ) VALUES (
        @intentId, @description, @targetFiles, @riskLevel,
        @status, @reviewer, @comment, @requestedAt, @resolvedAt
      )
    `).run({
      intentId: review.intentId,
      description: review.description,
      targetFiles: encodeArr(review.targetFiles),
      riskLevel: review.riskLevel,
      status: review.status,
      reviewer: review.reviewer ?? null,
      comment: review.comment ?? null,
      requestedAt: review.requestedAt,
      resolvedAt: review.resolvedAt ?? null,
    })
  }

  getPendingReview(intentId: string): PendingReview | null {
    const row = this.db.prepare(
      "SELECT * FROM pending_reviews WHERE intent_id = ?"
    ).get(intentId) as PendingReviewRow | undefined
    return row ? rowToPendingReview(row) : null
  }

  updatePendingReview(intentId: string, patch: Partial<PendingReview>): void {
    const fields: string[] = []
    const values: Record<string, unknown> = { intentId }

    if (patch.status !== undefined) {
      fields.push("status = @status")
      values["status"] = patch.status
    }
    if (patch.reviewer !== undefined) {
      fields.push("reviewer = @reviewer")
      values["reviewer"] = patch.reviewer ?? null
    }
    if (patch.comment !== undefined) {
      fields.push("comment = @comment")
      values["comment"] = patch.comment ?? null
    }
    if (patch.resolvedAt !== undefined) {
      fields.push("resolved_at = @resolvedAt")
      values["resolvedAt"] = patch.resolvedAt ?? null
    }

    if (fields.length === 0) return

    this.db.prepare(
      `UPDATE pending_reviews SET ${fields.join(", ")} WHERE intent_id = @intentId`
    ).run(values)
  }

  // -------------------------------------------------------------------------
  // Upstream Checks
  // -------------------------------------------------------------------------

  insertUpstreamCheck(check: Omit<UpstreamCheck, "id">): void {
    this.db.prepare(`
      INSERT INTO upstream_checks (
        new_commits, changed_files, added_lines, removed_lines,
        checked_at, intent_generated
      ) VALUES (
        @newCommits, @changedFiles, @addedLines, @removedLines,
        @checkedAt, @intentGenerated
      )
    `).run({
      newCommits: encodeArr(check.newCommits),
      changedFiles: encodeArr(check.changedFiles),
      addedLines: check.addedLines,
      removedLines: check.removedLines,
      checkedAt: check.checkedAt,
      intentGenerated: check.intentGenerated ? 1 : 0,
    })
  }

  getLastUpstreamCheck(): UpstreamCheck | null {
    const row = this.db.prepare(
      "SELECT * FROM upstream_checks ORDER BY checked_at DESC LIMIT 1"
    ).get() as UpstreamCheckRow | undefined
    return row ? rowToUpstreamCheck(row) : null
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  close(): void {
    this.db.close()
  }
}
