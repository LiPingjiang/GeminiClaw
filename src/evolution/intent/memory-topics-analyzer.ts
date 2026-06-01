// @ts-nocheck
// src/evolution/intent/memory-topics-analyzer.ts
// Analyzes layered memory SQLite DB for topics with large summary content
// and generates "performance" type intents.
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import Database from "better-sqlite3";
const DEFAULT_CONFIG = {
    tokenThreshold: 4000,
};
// ---------------------------------------------------------------------------
// MemoryTopicsAnalyzer
// ---------------------------------------------------------------------------
export class MemoryTopicsAnalyzer {
    dbPath;
    config;
    constructor(dbPath, config) {
        this.dbPath = dbPath;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * Analyze the memory topics DB and return performance intents for topics
     * whose summary content exceeds the configured threshold.
     *
     * Returns [] if dbPath is ":memory:", does not exist, or any error occurs.
     */
    analyze() {
        // Guard: skip virtual/nonexistent paths
        if (this.dbPath === ":memory:")
            return [];
        if (!existsSync(this.dbPath))
            return [];
        try {
            const db = new Database(this.dbPath, { readonly: true });
            try {
                // Check if memory_topics table exists
                const tableExists = db.prepare(`
          SELECT name FROM sqlite_master WHERE type='table' AND name='memory_topics'
        `).get();
                if (!tableExists)
                    return [];
                // Query topics with large summary content
                const rows = db.prepare(`
          SELECT id, title, summary, doc_level2, doc_level3, doc_size
          FROM memory_topics
          WHERE active = 1
        `).all();
                const intents = [];
                const threshold = this.config.tokenThreshold;
                for (const row of rows) {
                    // Use the longest available content level for size estimation
                    const content = [row.doc_level3, row.doc_level2, row.summary]
                        .filter((s) => typeof s === "string" && s.length > 0)
                        .reduce((a, b) => (a.length >= b.length ? a : b), "");
                    if (content.length >= threshold) {
                        const now = Date.now();
                        intents.push({
                            id: randomUUID(),
                            type: "performance",
                            description: `Memory topic "${row.title}" has large summary content (${content.length} chars). Consider summarizing or archiving to reduce memory retrieval overhead.`,
                            targetFiles: ["src/memory/strategies/layered.ts"],
                            evidence: [
                                `Topic id: ${row.id}`,
                                `Content length: ${content.length} chars (threshold: ${threshold})`,
                                `doc_size: ${row.doc_size}`,
                            ],
                            riskLevel: "low",
                            status: "pending",
                            createdAt: now,
                            updatedAt: now,
                        });
                    }
                }
                return intents;
            }
            finally {
                db.close();
            }
        }
        catch {
            // Never throw — return empty on any error
            return [];
        }
    }
}
