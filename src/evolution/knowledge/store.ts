/**
 * src/evolution/knowledge/store.ts
 * KnowledgeStore — 知识条目的持久化存储
 *
 * 每条知识有生命周期：active → stale(30d) → archived(90d)
 * pinned 条目永不过期。
 * 使用 absorbed_into 归档机制：合并时永不删除，只标记去向。
 *
 * 存储后端：SQLite（复用 evolution DB）
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type KnowledgeCategory =
  | "user_preference"    // 用户偏好（编码风格、命名习惯等）
  | "behavioral_pattern" // 行为模式（常用操作、工作流程等）
  | "domain_knowledge"   // 领域知识（业务概念、架构决策等）
  | "technique"          // 技术技巧（代码模式、最佳实践等）
  | "correction"         // 纠正（用户指出的错误、不应做的事等）

export type KnowledgeStatus =
  | "active"    // 当前活跃
  | "stale"     // 超过 30 天未被引用
  | "archived"  // 超过 90 天/被合并/被废弃
  | "pinned"    // 永不过期

export interface KnowledgeEntry {
  id: string
  content: string
  category: KnowledgeCategory
  status: KnowledgeStatus
  /** Source: which session/turn produced this */
  source: {
    sessionId: string
    turnIndex?: number
    timestamp: number
  }
  /** Tags for retrieval */
  tags: string[]
  /** How many times this knowledge was referenced in context building */
  referenceCount: number
  /** Last time it was referenced */
  lastReferencedAt: number
  /** If archived via merge, points to the umbrella entry that absorbed it */
  absorbedInto?: string
  /** Creation timestamp */
  createdAt: number
  /** Last modified timestamp */
  updatedAt: number
  /** Confidence score from the reviewer (0-1) */
  confidence: number
}

export interface KnowledgeQuery {
  category?: KnowledgeCategory
  status?: KnowledgeStatus | KnowledgeStatus[]
  tags?: string[]
  /** Free text search in content */
  search?: string
  /** Only entries created after this timestamp */
  since?: number
  /** Max results */
  limit?: number
}

// ── KnowledgeStore ───────────────────────────────────────────────────────────

export class KnowledgeStore {
  private entries: Map<string, KnowledgeEntry> = new Map()
  private nextId = 1

  /**
   * Add a new knowledge entry.
   */
  add(params: {
    content: string
    category: KnowledgeCategory
    source: KnowledgeEntry["source"]
    tags?: string[]
    confidence?: number
    pinned?: boolean
  }): KnowledgeEntry {
    const id = `k_${Date.now()}_${this.nextId++}`
    const entry: KnowledgeEntry = {
      id,
      content: params.content,
      category: params.category,
      status: params.pinned ? "pinned" : "active",
      source: params.source,
      tags: params.tags ?? [],
      referenceCount: 0,
      lastReferencedAt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      confidence: params.confidence ?? 0.8,
    }
    this.entries.set(id, entry)
    return entry
  }

  /**
   * Update an existing entry's content.
   */
  update(id: string, updates: Partial<Pick<KnowledgeEntry, "content" | "tags" | "confidence" | "status">>): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false

    if (updates.content !== undefined) entry.content = updates.content
    if (updates.tags !== undefined) entry.tags = updates.tags
    if (updates.confidence !== undefined) entry.confidence = updates.confidence
    if (updates.status !== undefined) entry.status = updates.status
    entry.updatedAt = Date.now()
    return true
  }

  /**
   * Mark entry as referenced (updates reference count and timestamp).
   */
  markReferenced(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.referenceCount++
    entry.lastReferencedAt = Date.now()
    // If it was stale, reactivate it
    if (entry.status === "stale") {
      entry.status = "active"
    }
  }

  /**
   * Archive an entry, optionally noting what it was absorbed into.
   */
  archive(id: string, absorbedInto?: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    if (entry.status === "pinned") return false // Cannot archive pinned

    entry.status = "archived"
    entry.absorbedInto = absorbedInto
    entry.updatedAt = Date.now()
    return true
  }

  /**
   * Pin an entry (protect from expiration/curation).
   */
  pin(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    entry.status = "pinned"
    entry.updatedAt = Date.now()
    return true
  }

  /**
   * Query entries with flexible filters.
   */
  query(q: KnowledgeQuery): KnowledgeEntry[] {
    let results = Array.from(this.entries.values())

    if (q.category) {
      results = results.filter((e) => e.category === q.category)
    }

    if (q.status) {
      const statuses = Array.isArray(q.status) ? q.status : [q.status]
      results = results.filter((e) => statuses.includes(e.status))
    }

    if (q.tags && q.tags.length > 0) {
      results = results.filter((e) =>
        q.tags!.some((tag) => e.tags.includes(tag)),
      )
    }

    if (q.search) {
      const lower = q.search.toLowerCase()
      results = results.filter((e) => e.content.toLowerCase().includes(lower))
    }

    if (q.since) {
      results = results.filter((e) => e.createdAt >= q.since!)
    }

    // Sort by reference count (most referenced first), then recency
    results.sort((a, b) => {
      if (b.referenceCount !== a.referenceCount) return b.referenceCount - a.referenceCount
      return b.updatedAt - a.updatedAt
    })

    if (q.limit) {
      results = results.slice(0, q.limit)
    }

    return results
  }

  /**
   * Get all active knowledge for context injection.
   * Returns entries sorted by relevance (reference count + recency).
   */
  getActiveKnowledge(limit = 50): KnowledgeEntry[] {
    return this.query({
      status: ["active", "pinned"],
      limit,
    })
  }

  /**
   * Get a single entry by ID.
   */
  get(id: string): KnowledgeEntry | undefined {
    return this.entries.get(id)
  }

  /**
   * Get total counts by status.
   */
  getStats(): Record<KnowledgeStatus, number> {
    const stats: Record<KnowledgeStatus, number> = {
      active: 0,
      stale: 0,
      archived: 0,
      pinned: 0,
    }
    for (const entry of this.entries.values()) {
      stats[entry.status]++
    }
    return stats
  }

  /**
   * Run lifecycle transitions:
   * - active → stale after 30 days without reference
   * - stale → archived after 90 days without reference
   * Pinned entries are exempt.
   */
  runLifecycle(): { staled: number; archived: number } {
    const now = Date.now()
    const STALE_THRESHOLD = 30 * 24 * 60 * 60 * 1000  // 30 days
    const ARCHIVE_THRESHOLD = 90 * 24 * 60 * 60 * 1000 // 90 days

    let staled = 0
    let archived = 0

    for (const entry of this.entries.values()) {
      if (entry.status === "pinned" || entry.status === "archived") continue

      const lastActivity = entry.lastReferencedAt || entry.createdAt
      const age = now - lastActivity

      if (entry.status === "stale" && age > ARCHIVE_THRESHOLD) {
        entry.status = "archived"
        entry.updatedAt = now
        archived++
      } else if (entry.status === "active" && age > STALE_THRESHOLD) {
        entry.status = "stale"
        entry.updatedAt = now
        staled++
      }
    }

    return { staled, archived }
  }

  /**
   * Check for duplicate/similar content before adding.
   * Simple prefix matching for now; LLM-based dedup in Curator.
   */
  findSimilar(content: string, threshold = 0.8): KnowledgeEntry[] {
    const normalized = content.toLowerCase().trim()
    return Array.from(this.entries.values()).filter((e) => {
      if (e.status === "archived") return false
      const entryNorm = e.content.toLowerCase().trim()
      // Simple containment check
      if (entryNorm.includes(normalized) || normalized.includes(entryNorm)) {
        return true
      }
      // Prefix similarity (first 100 chars)
      const prefix = normalized.slice(0, 100)
      return entryNorm.startsWith(prefix)
    })
  }

  /**
   * Get count of all entries (for diagnostics).
   */
  get size(): number {
    return this.entries.size
  }

  /**
   * Export all entries (for persistence/backup).
   */
  export(): KnowledgeEntry[] {
    return Array.from(this.entries.values())
  }

  /**
   * Import entries (for restore from persistence).
   */
  import(entries: KnowledgeEntry[]): void {
    for (const entry of entries) {
      this.entries.set(entry.id, entry)
    }
  }
}
