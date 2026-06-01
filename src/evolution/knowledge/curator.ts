/**
 * src/evolution/knowledge/curator.ts
 * Curator — 第 2 层知识进化：定期知识整理
 *
 * 功能（对齐 Hermes）：
 * - prefix clustering → umbrella consolidation（合并相似知识）
 * - 状态转换：active → stale(30d) → archived(90d)
 * - pinned 条目永不动
 * - dry-run 模式预览
 * - 产出 REPORT.md
 *
 * 触发频率：每 7 天（或手动触发）
 */

import { KnowledgeStore, type KnowledgeEntry, type KnowledgeCategory } from "./store.js"
import type { ChatFunction } from "./background-review.js"

// ── Types ────────────────────────────────────────────────────────────────────

export interface CuratorConfig {
  /** How often to run curation (default 7 days) */
  intervalMs: number
  /** Minimum entries in a cluster to trigger umbrella merge */
  minClusterSize: number
  /** Whether curation is enabled */
  enabled: boolean
}

const DEFAULT_CONFIG: CuratorConfig = {
  intervalMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  minClusterSize: 3,
  enabled: true,
}

export interface CurationAction {
  type: "lifecycle" | "merge" | "archive"
  description: string
  affectedIds: string[]
  newEntryId?: string
}

export interface CurationReport {
  timestamp: number
  dryRun: boolean
  actions: CurationAction[]
  stats: {
    totalEntries: number
    activeEntries: number
    staledCount: number
    archivedCount: number
    mergedCount: number
    clustersFound: number
  }
}

// ── Cluster Detection ────────────────────────────────────────────────────────

interface Cluster {
  category: KnowledgeCategory
  prefix: string
  entries: KnowledgeEntry[]
}

/**
 * Simple prefix-based clustering.
 * Groups entries by category and first N significant words.
 */
function detectClusters(entries: KnowledgeEntry[], prefixWords = 4): Cluster[] {
  const groups = new Map<string, KnowledgeEntry[]>()

  for (const entry of entries) {
    // Generate cluster key from category + prefix words
    const words = entry.content
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .slice(0, prefixWords)
    const key = `${entry.category}::${words.join(" ")}`
    const group = groups.get(key) ?? []
    group.push(entry)
    groups.set(key, group)
  }

  // Also cluster by shared tags
  const tagGroups = new Map<string, KnowledgeEntry[]>()
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const key = `${entry.category}::tag:${tag}`
      const group = tagGroups.get(key) ?? []
      group.push(entry)
      tagGroups.set(key, group)
    }
  }

  // Merge both grouping strategies
  const allGroups = new Map<string, KnowledgeEntry[]>()
  for (const [key, group] of groups) allGroups.set(key, group)
  for (const [key, group] of tagGroups) {
    const existing = allGroups.get(key)
    if (!existing || group.length > existing.length) {
      allGroups.set(key, group)
    }
  }

  // Convert to clusters, filter by minimum size
  const clusters: Cluster[] = []
  const seen = new Set<string>() // Avoid duplicate entries in clusters

  for (const [key, entries] of allGroups) {
    if (entries.length < 2) continue
    // Deduplicate entries within a cluster
    const unique = entries.filter((e) => !seen.has(e.id))
    if (unique.length < 2) continue

    for (const e of unique) seen.add(e.id)

    const category = key.split("::")[0] as KnowledgeCategory
    const prefix = key.split("::").slice(1).join("::")
    clusters.push({ category, prefix, entries: unique })
  }

  return clusters
}

// ── Curator ──────────────────────────────────────────────────────────────────

export class Curator {
  private store: KnowledgeStore
  private chatFn: ChatFunction | null
  private config: CuratorConfig
  private lastRunAt = 0

  constructor(params: {
    store: KnowledgeStore
    chatFn?: ChatFunction
    config?: Partial<CuratorConfig>
  }) {
    this.store = params.store
    this.chatFn = params.chatFn ?? null
    this.config = { ...DEFAULT_CONFIG, ...params.config }
  }

  /**
   * Check if curation is due.
   */
  isDue(): boolean {
    if (!this.config.enabled) return false
    return Date.now() - this.lastRunAt > this.config.intervalMs
  }

  /**
   * Run curation. In dry-run mode, produces report without making changes.
   */
  async run(dryRun = false): Promise<CurationReport> {
    const timestamp = Date.now()
    const actions: CurationAction[] = []

    // 1. Run lifecycle transitions (stale/archive)
    if (!dryRun) {
      const lifecycle = this.store.runLifecycle()
      if (lifecycle.staled > 0 || lifecycle.archived > 0) {
        actions.push({
          type: "lifecycle",
          description: `Lifecycle: ${lifecycle.staled} staled, ${lifecycle.archived} archived`,
          affectedIds: [], // Not tracked individually for performance
        })
      }
    }

    // 2. Detect clusters among active entries
    const activeEntries = this.store.getActiveKnowledge(500)
    const clusters = detectClusters(activeEntries, 4)
      .filter((c) => c.entries.length >= this.config.minClusterSize)

    // 3. Merge clusters into umbrella entries
    let mergedCount = 0
    for (const cluster of clusters) {
      const umbrellaContent = await this.generateUmbrella(cluster)
      if (!umbrellaContent) continue

      if (!dryRun) {
        // Create umbrella entry
        const umbrella = this.store.add({
          content: umbrellaContent,
          category: cluster.category,
          source: {
            sessionId: "curator",
            timestamp,
          },
          tags: this.extractCommonTags(cluster.entries),
          confidence: this.averageConfidence(cluster.entries),
        })

        // Archive constituents with absorbed_into pointer
        for (const entry of cluster.entries) {
          this.store.archive(entry.id, umbrella.id)
        }

        actions.push({
          type: "merge",
          description: `Merged ${cluster.entries.length} entries into umbrella: "${umbrellaContent.slice(0, 60)}..."`,
          affectedIds: cluster.entries.map((e) => e.id),
          newEntryId: umbrella.id,
        })
      } else {
        actions.push({
          type: "merge",
          description: `[DRY-RUN] Would merge ${cluster.entries.length} entries (prefix: "${cluster.prefix}")`,
          affectedIds: cluster.entries.map((e) => e.id),
        })
      }

      mergedCount += cluster.entries.length
    }

    this.lastRunAt = timestamp

    // Build report
    const stats = this.store.getStats()
    const report: CurationReport = {
      timestamp,
      dryRun,
      actions,
      stats: {
        totalEntries: this.store.size,
        activeEntries: stats.active + stats.pinned,
        staledCount: stats.stale,
        archivedCount: stats.archived,
        mergedCount,
        clustersFound: clusters.length,
      },
    }

    return report
  }

  /**
   * Generate umbrella content from a cluster.
   * Uses LLM if available, otherwise simple concatenation.
   */
  private async generateUmbrella(cluster: Cluster): Promise<string | null> {
    if (this.chatFn) {
      try {
        const response = await this.chatFn([
          {
            role: "system",
            content: `You are a knowledge consolidation assistant. Given multiple related knowledge entries, create a single concise entry that captures all the important information. Output ONLY the consolidated knowledge text, no explanations.`,
          },
          {
            role: "user",
            content: `Category: ${cluster.category}\n\nEntries to consolidate:\n${cluster.entries.map((e, i) => `${i + 1}. ${e.content}`).join("\n")}\n\nCreate one consolidated entry:`,
          },
        ])
        return response.content.trim()
      } catch {
        // Fall through to simple merge
      }
    }

    // Simple fallback: combine with separator
    return cluster.entries.map((e) => e.content).join("; ")
  }

  /**
   * Extract tags that appear in majority of entries.
   */
  private extractCommonTags(entries: KnowledgeEntry[]): string[] {
    const tagCounts = new Map<string, number>()
    for (const entry of entries) {
      for (const tag of entry.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
      }
    }

    const threshold = entries.length * 0.5
    return Array.from(tagCounts.entries())
      .filter(([, count]) => count >= threshold)
      .map(([tag]) => tag)
  }

  /**
   * Average confidence of entries.
   */
  private averageConfidence(entries: KnowledgeEntry[]): number {
    if (entries.length === 0) return 0.5
    const sum = entries.reduce((acc, e) => acc + e.confidence, 0)
    return Math.round((sum / entries.length) * 100) / 100
  }

  /**
   * Format report as markdown (for REPORT.md output).
   */
  formatReport(report: CurationReport): string {
    const date = new Date(report.timestamp).toISOString().slice(0, 19)
    let md = `# Knowledge Curation Report\n\n`
    md += `- **Date**: ${date}\n`
    md += `- **Mode**: ${report.dryRun ? "DRY-RUN (no changes made)" : "LIVE"}\n`
    md += `- **Total entries**: ${report.stats.totalEntries}\n`
    md += `- **Active**: ${report.stats.activeEntries}\n`
    md += `- **Stale**: ${report.stats.staledCount}\n`
    md += `- **Archived**: ${report.stats.archivedCount}\n`
    md += `- **Clusters found**: ${report.stats.clustersFound}\n`
    md += `- **Entries merged**: ${report.stats.mergedCount}\n\n`

    if (report.actions.length > 0) {
      md += `## Actions\n\n`
      for (const action of report.actions) {
        md += `- [${action.type}] ${action.description}\n`
      }
    } else {
      md += `## No actions needed\n\nKnowledge base is well-organized.\n`
    }

    return md
  }
}
