// @ts-nocheck
// src/evolution/db.ts
// SQLite data layer for the Evolution Engine
// Uses better-sqlite3 (synchronous API) for simplicity and reliability.
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
// ---------------------------------------------------------------------------
// Helpers: JSON encode/decode arrays
// ---------------------------------------------------------------------------
function encodeArr(arr) {
    return JSON.stringify(arr);
}
function decodeArr(json) {
    if (!json)
        return [];
    try {
        return JSON.parse(json);
    }
    catch {
        return [];
    }
}
// ---------------------------------------------------------------------------
// Mappers: DB row → domain type
// ---------------------------------------------------------------------------
function rowToIntent(row) {
    return {
        id: row.id,
        type: row.type,
        description: row.description,
        targetFiles: decodeArr(row.target_files),
        evidence: decodeArr(row.evidence),
        riskLevel: row.risk_level,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function rowToTrace(row) {
    return {
        id: row.id,
        sessionId: row.session_id,
        toolSequence: decodeArr(row.tool_sequence),
        hadFailure: row.had_failure === 1,
        messageCount: row.message_count,
        responseLength: row.response_length ?? 0,
        recordedAt: row.recorded_at,
    };
}
function rowToEvolution(row) {
    return {
        id: row.id,
        intentId: row.intent_id,
        type: row.type,
        fromSlot: row.from_slot,
        toSlot: row.to_slot,
        changedFiles: decodeArr(row.changed_files),
        recordedAt: row.recorded_at,
    };
}
function rowToSlotState(row) {
    return {
        slotId: row.slot_id,
        role: row.role,
        buildHash: row.build_hash,
        builtAt: row.built_at,
        lastActivatedAt: row.last_activated_at ?? undefined,
    };
}
function rowToUpstreamCheck(row) {
    return {
        id: row.id,
        newCommits: decodeArr(row.new_commits),
        changedFiles: decodeArr(row.changed_files),
        addedLines: row.added_lines,
        removedLines: row.removed_lines,
        checkedAt: row.checked_at,
        intentGenerated: row.intent_generated === 1,
    };
}
function rowToPendingReview(row) {
    return {
        intentId: row.intent_id,
        description: row.description,
        targetFiles: decodeArr(row.target_files),
        riskLevel: row.risk_level,
        status: row.status,
        reviewer: row.reviewer ?? undefined,
        comment: row.comment ?? undefined,
        requestedAt: row.requested_at,
        resolvedAt: row.resolved_at ?? undefined,
    };
}
function rowToConversationSample(row) {
    return {
        id: row.id,
        sessionId: row.session_id,
        traceId: row.trace_id ?? undefined,
        userMessage: row.user_message,
        agentReply: row.agent_reply,
        toolSequence: decodeArr(row.tool_sequence),
        hadFailure: row.had_failure === 1,
        recordedAt: row.recorded_at,
    };
}
function rowToEvolutionPreview(row) {
    return {
        id: row.id,
        intentId: row.intent_id,
        sampleId: row.sample_id,
        userMessage: row.user_message,
        beforeReply: row.before_reply,
        afterReply: row.after_reply,
        summary: row.summary,
        generatedAt: row.generated_at,
    };
}
// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------
const DDL = `
CREATE TABLE IF NOT EXISTS intents (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  description   TEXT NOT NULL,
  target_files  TEXT NOT NULL DEFAULT '[]',
  evidence      TEXT NOT NULL DEFAULT '[]',
  risk_level    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
CREATE INDEX IF NOT EXISTS idx_intents_created_at ON intents(created_at);

CREATE TABLE IF NOT EXISTS traces (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  tool_sequence    TEXT NOT NULL DEFAULT '[]',
  had_failure      INTEGER NOT NULL DEFAULT 0,
  message_count    INTEGER NOT NULL DEFAULT 0,
  response_length  INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS tracked_files (
  file_path          TEXT PRIMARY KEY,
  file_type          TEXT NOT NULL,
  added_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tracked_files_type ON tracked_files(file_type);

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

CREATE TABLE IF NOT EXISTS conversation_samples (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  trace_id     TEXT,
  user_message TEXT NOT NULL,
  agent_reply  TEXT NOT NULL,
  tool_sequence TEXT NOT NULL DEFAULT '[]',
  had_failure  INTEGER NOT NULL DEFAULT 0,
  recorded_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_session ON conversation_samples(session_id);
CREATE INDEX IF NOT EXISTS idx_samples_recorded ON conversation_samples(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_samples_failure ON conversation_samples(had_failure);

CREATE TABLE IF NOT EXISTS evolution_previews (
  id           TEXT PRIMARY KEY,
  intent_id    TEXT NOT NULL,
  sample_id    TEXT NOT NULL,
  user_message TEXT NOT NULL,
  before_reply TEXT NOT NULL,
  after_reply  TEXT NOT NULL,
  summary      TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_previews_intent ON evolution_previews(intent_id);
`;
// ---------------------------------------------------------------------------
// EvolutionDB
// ---------------------------------------------------------------------------
export class EvolutionDB {
    db: any;
    constructor(dbPath) {
        mkdirSync(dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this.migrate();
    }
    migrate() {
        this.db.exec(DDL);
    }
    // -------------------------------------------------------------------------
    // File Tracking
    // -------------------------------------------------------------------------
    addTrackedFile(filePath, fileType) {
        this.db.prepare(`
      INSERT OR IGNORE INTO tracked_files (file_path, file_type, added_at)
      VALUES (?, ?, ?)
    `).run(filePath, fileType, Date.now());
    }
    getTrackedFiles(fileType) {
        if (fileType) {
            const rows = this.db.prepare(`SELECT file_path as filePath, file_type as fileType FROM tracked_files WHERE file_type = ?`).all(fileType);
            return rows;
        }
        else {
            const rows = this.db.prepare(`SELECT file_path as filePath, file_type as fileType FROM tracked_files`).all();
            return rows;
        }
    }
    // -------------------------------------------------------------------------
    // Intents
    // -------------------------------------------------------------------------
    insertIntent(intent) {
        this.db.prepare(`
      INSERT INTO intents (
        id, type, description, target_files, evidence,
        risk_level, status,
        created_at, updated_at
      ) VALUES (
        @id, @type, @description, @targetFiles, @evidence,
        @riskLevel, @status,
        @createdAt, @updatedAt
      )
    `).run({
            id: intent.id,
            type: intent.type,
            description: intent.description,
            targetFiles: encodeArr(intent.targetFiles),
            evidence: encodeArr(intent.evidence),
            riskLevel: intent.riskLevel,
            status: intent.status,
            createdAt: intent.createdAt,
            updatedAt: intent.updatedAt,
        });
    }
    getIntent(id) {
        const row = this.db.prepare("SELECT * FROM intents WHERE id = ?").get(id);
        return row ? rowToIntent(row) : null;
    }
    listIntents(filter) {
        if (filter?.status) {
            const rows = this.db.prepare("SELECT * FROM intents WHERE status = ? ORDER BY created_at ASC").all(filter.status);
            return rows.map(rowToIntent);
        }
        const rows = this.db.prepare("SELECT * FROM intents ORDER BY created_at ASC").all();
        return rows.map(rowToIntent);
    }
    /**
     * Check if a pending intent with the exact same description already exists.
     * Used by IntentEngine to avoid duplicate intent generation.
     */
    hasPendingIntentWithDescription(description) {
        // 去重范围：所有非 completed 状态的 intent，无时间窗口限制
        // 包含 pending/in_progress/validating/rejected/approved
        // 防止同一 intent 被反复创建（之前 24h 窗口 + 缺少 approved 导致 skill-bootstrap 重复 13 次）
        const row = this.db
            .prepare(`SELECT id FROM intents WHERE description = ? AND status IN ('pending','in_progress','validating','rejected','approved') LIMIT 1`)
            .get(description);
        return row !== undefined;
    }
    updateIntentStatus(id, status) {
        this.db.prepare("UPDATE intents SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
    }
    // -------------------------------------------------------------------------
    // Traces
    // -------------------------------------------------------------------------
    insertTrace(trace) {
        this.db.prepare(`
      INSERT INTO traces (id, session_id, tool_sequence, had_failure, message_count, response_length, recorded_at)
      VALUES (@id, @sessionId, @toolSequence, @hadFailure, @messageCount, @responseLength, @recordedAt)
    `).run({
            id: trace.id,
            sessionId: trace.sessionId,
            toolSequence: encodeArr(trace.toolSequence),
            hadFailure: trace.hadFailure ? 1 : 0,
            messageCount: trace.messageCount,
            responseLength: trace.responseLength ?? 0,
            recordedAt: trace.recordedAt,
        });
    }
    getRecentTraces(limit) {
        const rows = this.db.prepare("SELECT * FROM traces ORDER BY recorded_at DESC LIMIT ?").all(limit);
        return rows.map(rowToTrace);
    }
    countTraces() {
        const result = this.db.prepare("SELECT COUNT(*) as cnt FROM traces").get();
        return result.cnt;
    }
    /** Returns the failure rate (0-1) within the given time window (ms). */
    getFailureRate(windowMs) {
        const since = Date.now() - windowMs;
        const result = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(had_failure) as failures
      FROM traces
      WHERE recorded_at >= ?
    `).get(since);
        if (!result.total)
            return 0;
        return (result.failures ?? 0) / result.total;
    }
    // -------------------------------------------------------------------------
    // Evolution History
    // -------------------------------------------------------------------------
    insertEvolutionRecord(record) {
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
        });
    }
    getLastEvolutionRecord() {
        const row = this.db.prepare("SELECT * FROM evolution_history ORDER BY recorded_at DESC LIMIT 1").get();
        return row ? rowToEvolution(row) : null;
    }
    /**
     * Returns the number of evolution records (switches) that touched the given file
     * within the given time window (ms). Used by CircuitBreaker frequency limiting.
     */
    getEvolutionCountForFile(file, windowMs) {
        const since = Date.now() - windowMs;
        const rows = this.db.prepare(`
      SELECT changed_files FROM evolution_history
      WHERE type = 'switch' AND recorded_at >= ?
    `).all(since);
        let count = 0;
        for (const row of rows) {
            const files = decodeArr(row.changed_files);
            if (files.some(f => f === file || f.startsWith(file) || file.startsWith(f))) {
                count++;
            }
        }
        return count;
    }
    listEvolutionHistory(limit = 20) {
        const rows = this.db.prepare("SELECT * FROM evolution_history ORDER BY recorded_at DESC LIMIT ?").all(limit);
        return rows.map(rowToEvolution);
    }
    // -------------------------------------------------------------------------
    // Slot State
    // -------------------------------------------------------------------------
    getSlotState(slotId) {
        const row = this.db.prepare("SELECT * FROM slot_state WHERE slot_id = ?").get(slotId);
        return row ? rowToSlotState(row) : null;
    }
    upsertSlotState(state) {
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
        });
    }
    // -------------------------------------------------------------------------
    // Pending Reviews
    // -------------------------------------------------------------------------
    listPendingReviews() {
        const rows = this.db.prepare(`SELECT * FROM pending_reviews WHERE status = 'pending' ORDER BY requested_at ASC`).all();
        return rows.map(rowToPendingReview);
    }
    resolvePendingReview(intentId, status, reviewer) {
        this.db.prepare(`
      UPDATE pending_reviews
      SET status = @status, reviewer = @reviewer, resolved_at = @resolvedAt
      WHERE intent_id = @intentId
    `).run({
            intentId,
            status,
            reviewer: reviewer ?? null,
            resolvedAt: Date.now(),
        });
    }
    insertPendingReview(review) {
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
        });
    }
    getPendingReview(intentId) {
        const row = this.db.prepare("SELECT * FROM pending_reviews WHERE intent_id = ?").get(intentId);
        return row ? rowToPendingReview(row) : null;
    }
    updatePendingReview(intentId, patch) {
        const fields = [];
        const values = { intentId };
        if (patch.status !== undefined) {
            fields.push("status = @status");
            values["status"] = patch.status;
        }
        if (patch.reviewer !== undefined) {
            fields.push("reviewer = @reviewer");
            values["reviewer"] = patch.reviewer ?? null;
        }
        if (patch.comment !== undefined) {
            fields.push("comment = @comment");
            values["comment"] = patch.comment ?? null;
        }
        if (patch.resolvedAt !== undefined) {
            fields.push("resolved_at = @resolvedAt");
            values["resolvedAt"] = patch.resolvedAt ?? null;
        }
        if (fields.length === 0)
            return;
        this.db.prepare(`UPDATE pending_reviews SET ${fields.join(", ")} WHERE intent_id = @intentId`).run(values);
    }
    // -------------------------------------------------------------------------
    // ConversationSample
    // -------------------------------------------------------------------------
    insertConversationSample(sample) {
        this.db.prepare(`
      INSERT INTO conversation_samples
        (id, session_id, trace_id, user_message, agent_reply, tool_sequence, had_failure, recorded_at)
      VALUES
        (@id, @sessionId, @traceId, @userMessage, @agentReply, @toolSequence, @hadFailure, @recordedAt)
    `).run({
            id: sample.id,
            sessionId: sample.sessionId,
            traceId: sample.traceId ?? null,
            userMessage: sample.userMessage,
            agentReply: sample.agentReply,
            toolSequence: encodeArr(sample.toolSequence),
            hadFailure: sample.hadFailure ? 1 : 0,
            recordedAt: sample.recordedAt,
        });
        // Prune: keep only the most recent 500 samples
        this.db.prepare(`
      DELETE FROM conversation_samples
      WHERE id NOT IN (
        SELECT id FROM conversation_samples ORDER BY recorded_at DESC LIMIT 500
      )
    `).run();
    }
    listConversationSamples(opts = {}) {
        const { limit = 20, failureOnly = false } = opts;
        const rows = failureOnly
            ? this.db.prepare(`SELECT * FROM conversation_samples WHERE had_failure = 1 ORDER BY recorded_at DESC LIMIT ?`).all(limit)
            : this.db.prepare(`SELECT * FROM conversation_samples ORDER BY recorded_at DESC LIMIT ?`).all(limit);
        return rows.map(rowToConversationSample);
    }
    countConversationSamples() {
        const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM conversation_samples`).get();
        return row.cnt;
    }
    // -------------------------------------------------------------------------
    // EvolutionPreview
    // -------------------------------------------------------------------------
    insertEvolutionPreview(preview) {
        this.db.prepare(`
      INSERT OR REPLACE INTO evolution_previews
        (id, intent_id, sample_id, user_message, before_reply, after_reply, summary, generated_at)
      VALUES
        (@id, @intentId, @sampleId, @userMessage, @beforeReply, @afterReply, @summary, @generatedAt)
    `).run({
            id: preview.id,
            intentId: preview.intentId,
            sampleId: preview.sampleId,
            userMessage: preview.userMessage,
            beforeReply: preview.beforeReply,
            afterReply: preview.afterReply,
            summary: preview.summary,
            generatedAt: preview.generatedAt,
        });
    }
    listEvolutionPreviews(intentId) {
        const rows = this.db.prepare(`SELECT * FROM evolution_previews WHERE intent_id = ? ORDER BY generated_at DESC`).all(intentId);
        return rows.map(rowToEvolutionPreview);
    }
    hasEvolutionPreview(intentId) {
        const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM evolution_previews WHERE intent_id = ?`).get(intentId);
        return row.cnt > 0;
    }
    // -------------------------------------------------------------------------
    // Upstream Checks
    // -------------------------------------------------------------------------
    insertUpstreamCheck(check) {
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
        });
    }
    getLastUpstreamCheck() {
        const row = this.db.prepare("SELECT * FROM upstream_checks ORDER BY checked_at DESC LIMIT 1").get();
        return row ? rowToUpstreamCheck(row) : null;
    }
    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    close() {
        this.db.close();
    }
}
