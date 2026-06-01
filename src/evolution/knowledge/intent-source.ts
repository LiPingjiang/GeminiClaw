/**
 * KnowledgeIntentSource — Bridge between Knowledge Layer and Evolution Engine.
 *
 * Scans the KnowledgeStore for high-confidence insights that suggest
 * code changes, then generates EvolutionIntent candidates.
 *
 * Trigger rules:
 * - "correction" entries with confidence ≥ 0.8 → behavior_fix intent
 * - "technique" entries ≥ 3 about same tag → optimization intent
 * - "behavioral_pattern" entries ≥ 2 → new_feature intent (workflow improvement)
 *
 * This module is designed to be called from IntentEngine.generateIntents()
 * as a 5th analysis source, or independently from the Curator post-run hook.
 */

import type { KnowledgeStore, KnowledgeEntry, KnowledgeCategory } from "./store.js"

// ── Types ────────────────────────────────────────────────────────────────────

export interface IntentCandidate {
  type: "behavior_fix" | "new_feature" | "optimization"
  description: string
  targetFiles: string[]
  evidence: string[]
  riskLevel: "low" | "medium" | "high"
  sourceEntryIds: string[]
  confidence: number
}

export interface KnowledgeIntentSourceConfig {
  /** Minimum confidence to consider a correction entry (default: 0.8) */
  correctionConfidenceThreshold: number
  /** Minimum entries per tag to trigger technique optimization (default: 3) */
  techniqueClusterMin: number
  /** Minimum entries per pattern to trigger feature suggestion (default: 2) */
  patternClusterMin: number
  /** Maximum intents to generate per run (default: 5) */
  maxIntentsPerRun: number
  /** How recently entries must have been created to be considered (ms, default: 7 days) */
  recentWindowMs: number
}

export const DEFAULT_KNOWLEDGE_INTENT_CONFIG: KnowledgeIntentSourceConfig = {
  correctionConfidenceThreshold: 0.8,
  techniqueClusterMin: 3,
  patternClusterMin: 2,
  maxIntentsPerRun: 5,
  recentWindowMs: 7 * 24 * 60 * 60 * 1000, // 7 days
}

// ── Intent Source ────────────────────────────────────────────────────────────

export class KnowledgeIntentSource {
  private store: KnowledgeStore
  private config: KnowledgeIntentSourceConfig

  constructor(store: KnowledgeStore, config?: Partial<KnowledgeIntentSourceConfig>) {
    this.store = store
    this.config = { ...DEFAULT_KNOWLEDGE_INTENT_CONFIG, ...config }
  }

  /**
   * Analyze the knowledge store and produce evolution intent candidates.
   * Compatible with the IntentEngine.generateIntents() aggregation pattern.
   */
  analyze(): IntentCandidate[] {
    const candidates: IntentCandidate[] = []
    const cutoff = Date.now() - this.config.recentWindowMs

    // 1. High-confidence corrections → behavior_fix intents
    const corrections = this.store.query({
      category: "correction",
      status: "active",
    }).filter((e) => e.confidence >= this.config.correctionConfidenceThreshold && e.createdAt >= cutoff)

    for (const correction of corrections) {
      const targetFiles = this.extractFilePaths(correction)
      candidates.push({
        type: "behavior_fix",
        description: `Fix: ${correction.content}`,
        targetFiles,
        evidence: [
          `Knowledge entry ${correction.id}: "${correction.content}"`,
          `Confidence: ${correction.confidence.toFixed(2)}`,
          `Source session: ${correction.source.sessionId}`,
        ],
        riskLevel: targetFiles.length > 2 ? "medium" : "low",
        sourceEntryIds: [correction.id],
        confidence: correction.confidence,
      })
    }

    // 2. Technique clusters → optimization intents
    const techniques = this.store.query({
      category: "technique",
      status: "active",
    }).filter((e) => e.createdAt >= cutoff)

    const techClusters = this.clusterByTag(techniques)
    for (const [tag, entries] of techClusters) {
      if (entries.length >= this.config.techniqueClusterMin) {
        const allFiles = entries.flatMap((e) => this.extractFilePaths(e))
        const uniqueFiles = [...new Set(allFiles)]
        const avgConfidence = entries.reduce((s, e) => s + e.confidence, 0) / entries.length

        candidates.push({
          type: "optimization",
          description: `Apply technique pattern "${tag}": ${entries.map((e) => e.content).join("; ")}`,
          targetFiles: uniqueFiles.length > 0 ? uniqueFiles : [`src/**/*${tag}*`],
          evidence: entries.map((e) => `${e.id}: "${e.content}" (confidence: ${e.confidence.toFixed(2)})`),
          riskLevel: uniqueFiles.length > 3 ? "medium" : "low",
          sourceEntryIds: entries.map((e) => e.id),
          confidence: avgConfidence,
        })
      }
    }

    // 3. Behavioral pattern clusters → new_feature intents (workflow improvement)
    const patterns = this.store.query({
      category: "behavioral_pattern",
      status: "active",
    }).filter((e) => e.createdAt >= cutoff)

    const patternClusters = this.clusterByTag(patterns)
    for (const [tag, entries] of patternClusters) {
      if (entries.length >= this.config.patternClusterMin) {
        const avgConfidence = entries.reduce((s, e) => s + e.confidence, 0) / entries.length
        // Only suggest if average confidence is meaningful
        if (avgConfidence < 0.6) continue

        candidates.push({
          type: "new_feature",
          description: `Workflow improvement for "${tag}": automate pattern observed ${entries.length}x`,
          targetFiles: entries.flatMap((e) => this.extractFilePaths(e)).filter((f, i, a) => a.indexOf(f) === i),
          evidence: entries.map((e) => `${e.id}: "${e.content}"`),
          riskLevel: "medium", // Workflow changes are medium risk
          sourceEntryIds: entries.map((e) => e.id),
          confidence: avgConfidence,
        })
      }
    }

    // Sort by confidence descending, limit
    candidates.sort((a, b) => b.confidence - a.confidence)
    return candidates.slice(0, this.config.maxIntentsPerRun)
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Extract file paths from a knowledge entry.
   * Looks at tags for path-like strings and content for file references.
   */
  private extractFilePaths(entry: KnowledgeEntry): string[] {
    const paths: string[] = []
    const filePattern = /(?:src|lib|test|tests)\/[\w\-/.]+\.\w+/g

    // Check tags for file-like patterns
    for (const tag of entry.tags) {
      if (tag.match(/^(src|lib|test|tests)\//)) {
        paths.push(tag)
      }
    }

    // Check content for file references
    const contentMatches = entry.content.match(filePattern)
    if (contentMatches) {
      paths.push(...contentMatches)
    }

    return [...new Set(paths)]
  }

  /**
   * Group entries by their first tag (primary topic).
   * Entries without tags go into a "_untagged" bucket.
   */
  private clusterByTag(entries: KnowledgeEntry[]): Map<string, KnowledgeEntry[]> {
    const clusters = new Map<string, KnowledgeEntry[]>()

    for (const entry of entries) {
      const tag = entry.tags[0] ?? "_untagged"
      const list = clusters.get(tag) ?? []
      list.push(entry)
      clusters.set(tag, list)
    }

    return clusters
  }
}
