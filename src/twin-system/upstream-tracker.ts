/**
 * UpstreamTracker — Cron-driven upstream diff detection and intent generation.
 *
 * Periodically checks configured upstream repositories for new commits,
 * analyzes the diff, and generates `upstream_sync` EvolutionIntents.
 *
 * Design:
 * - Uses GitOps interface for testability (no direct execSync)
 * - LLM-powered diff analysis to determine relevance
 * - Bookmark-based tracking (remembers last-seen commit per repo)
 * - Configurable check interval with exponential backoff on failures
 */

import { randomUUID } from "crypto"
import type { EvolutionIntent } from "./types.js"

// ── Types ────────────────────────────────────────────────────────────────────

export interface UpstreamRepo {
  /** Human-readable name */
  name: string
  /** Local path to the repo clone */
  path: string
  /** Remote name to fetch from (default: "origin") */
  remote?: string
  /** Branch to track (default: "main") */
  branch?: string
  /** Last known commit hash (bookmark) */
  lastKnownCommit?: string
}

export interface UpstreamGitOps {
  /** Fetch latest from remote */
  fetch(repoPath: string, remote: string): Promise<void>
  /** Get HEAD commit hash of a branch */
  getHeadCommit(repoPath: string, branch: string): Promise<string>
  /** Get commit log between two refs (one-line format) */
  getLog(repoPath: string, fromRef: string, toRef: string): Promise<string[]>
  /** Get diff stat summary between two refs */
  getDiffStat(repoPath: string, fromRef: string, toRef: string): Promise<string>
  /** Get list of changed files between two refs */
  getChangedFiles(repoPath: string, fromRef: string, toRef: string): Promise<string[]>
}

export interface DiffAnalyzer {
  /**
   * Analyze upstream diff and determine relevant intents.
   * Returns parsed intent suggestions from LLM or rule-based analysis.
   */
  analyze(params: {
    repoName: string
    commits: string[]
    diffStat: string
    changedFiles: string[]
  }): Promise<DiffAnalysisResult[]>
}

export interface DiffAnalysisResult {
  description: string
  targetFiles: string[]
  riskLevel: "low" | "medium" | "high"
  evidence: string[]
  relevanceScore: number
}

export interface UpstreamTrackerConfig {
  /** Repos to track */
  repos: UpstreamRepo[]
  /** Check interval in ms (default: 1 hour) */
  intervalMs: number
  /** Max commits to analyze per repo per check (default: 50) */
  maxCommitsPerCheck: number
  /** Minimum relevance score to generate intent (default: 0.5) */
  relevanceThreshold: number
  /** Max consecutive failures before exponential backoff (default: 3) */
  maxConsecutiveFailures: number
}

export const DEFAULT_TRACKER_CONFIG: Omit<UpstreamTrackerConfig, "repos"> = {
  intervalMs: 60 * 60 * 1000, // 1 hour
  maxCommitsPerCheck: 50,
  relevanceThreshold: 0.5,
  maxConsecutiveFailures: 3,
}

export interface TrackerCheckResult {
  repoName: string
  newCommits: number
  intentsGenerated: number
  error?: string
}

export interface TrackerStats {
  totalChecks: number
  totalIntentsGenerated: number
  consecutiveFailures: number
  lastCheckAt: number | null
  nextCheckAt: number | null
  repoBookmarks: Map<string, string>
}

// ── UpstreamTracker ──────────────────────────────────────────────────────────

export class UpstreamTracker {
  private git: UpstreamGitOps
  private analyzer: DiffAnalyzer
  private config: UpstreamTrackerConfig
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  /** Per-repo bookmark: last processed commit */
  private bookmarks = new Map<string, string>()
  /** Generated intents awaiting consumption */
  private intentQueue: EvolutionIntent[] = []
  /** Stats */
  private stats: TrackerStats = {
    totalChecks: 0,
    totalIntentsGenerated: 0,
    consecutiveFailures: 0,
    lastCheckAt: null,
    nextCheckAt: null,
    repoBookmarks: new Map(),
  }

  constructor(
    git: UpstreamGitOps,
    analyzer: DiffAnalyzer,
    config: Partial<UpstreamTrackerConfig> & { repos: UpstreamRepo[] },
  ) {
    this.git = git
    this.analyzer = analyzer
    this.config = { ...DEFAULT_TRACKER_CONFIG, ...config }

    // Initialize bookmarks from config
    for (const repo of this.config.repos) {
      if (repo.lastKnownCommit) {
        this.bookmarks.set(repo.name, repo.lastKnownCommit)
      }
    }
  }

  /**
   * Start the cron timer.
   */
  start(): void {
    if (this.running) return
    this.running = true
    this.stats.nextCheckAt = Date.now() + this.config.intervalMs

    this.timer = setInterval(() => {
      this.checkAll().catch(() => {})
    }, this.config.intervalMs)

    if (this.timer.unref) this.timer.unref()
  }

  /**
   * Stop the cron timer.
   */
  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.stats.nextCheckAt = null
  }

  /** Is the tracker running? */
  isRunning(): boolean {
    return this.running
  }

  /**
   * Run a single check cycle across all repos.
   * Can be called manually or by the cron timer.
   */
  async checkAll(): Promise<TrackerCheckResult[]> {
    this.stats.totalChecks++
    this.stats.lastCheckAt = Date.now()
    if (this.running) {
      this.stats.nextCheckAt = Date.now() + this.config.intervalMs
    }

    const results: TrackerCheckResult[] = []

    for (const repo of this.config.repos) {
      try {
        const result = await this.checkRepo(repo)
        results.push(result)
        this.stats.consecutiveFailures = 0
      } catch (err) {
        this.stats.consecutiveFailures++
        results.push({
          repoName: repo.name,
          newCommits: 0,
          intentsGenerated: 0,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return results
  }

  /**
   * Check a single repo for new commits and generate intents.
   */
  async checkRepo(repo: UpstreamRepo): Promise<TrackerCheckResult> {
    const remote = repo.remote ?? "origin"
    const branch = repo.branch ?? "main"

    // Fetch latest
    await this.git.fetch(repo.path, remote)

    // Get current HEAD
    const headCommit = await this.git.getHeadCommit(repo.path, `${remote}/${branch}`)
    const lastKnown = this.bookmarks.get(repo.name)

    // If first time or no bookmark, just record and skip
    if (!lastKnown) {
      this.bookmarks.set(repo.name, headCommit)
      this.stats.repoBookmarks.set(repo.name, headCommit)
      return { repoName: repo.name, newCommits: 0, intentsGenerated: 0 }
    }

    // No new commits
    if (lastKnown === headCommit) {
      return { repoName: repo.name, newCommits: 0, intentsGenerated: 0 }
    }

    // Get commits since last known
    const commits = await this.git.getLog(repo.path, lastKnown, headCommit)
    const limitedCommits = commits.slice(0, this.config.maxCommitsPerCheck)

    // Get diff info
    const diffStat = await this.git.getDiffStat(repo.path, lastKnown, headCommit)
    const changedFiles = await this.git.getChangedFiles(repo.path, lastKnown, headCommit)

    // Analyze
    const analysisResults = await this.analyzer.analyze({
      repoName: repo.name,
      commits: limitedCommits,
      diffStat,
      changedFiles,
    })

    // Filter by relevance and convert to intents
    const relevant = analysisResults.filter(
      (r) => r.relevanceScore >= this.config.relevanceThreshold,
    )

    const intents = relevant.map((r) => this.toIntent(repo.name, r, limitedCommits))
    this.intentQueue.push(...intents)
    this.stats.totalIntentsGenerated += intents.length

    // Update bookmark
    this.bookmarks.set(repo.name, headCommit)
    this.stats.repoBookmarks.set(repo.name, headCommit)

    return {
      repoName: repo.name,
      newCommits: commits.length,
      intentsGenerated: intents.length,
    }
  }

  /**
   * Consume generated intents.
   */
  drainIntents(): EvolutionIntent[] {
    const intents = [...this.intentQueue]
    this.intentQueue = []
    return intents
  }

  /**
   * Peek at pending intents without consuming.
   */
  peekIntents(): EvolutionIntent[] {
    return [...this.intentQueue]
  }

  /**
   * Get tracker statistics.
   */
  getStats(): TrackerStats {
    return {
      ...this.stats,
      repoBookmarks: new Map(this.stats.repoBookmarks),
    }
  }

  /**
   * Get the bookmark (last known commit) for a repo.
   */
  getBookmark(repoName: string): string | undefined {
    return this.bookmarks.get(repoName)
  }

  /**
   * Manually set a bookmark (useful for initialization from persistent storage).
   */
  setBookmark(repoName: string, commit: string): void {
    this.bookmarks.set(repoName, commit)
    this.stats.repoBookmarks.set(repoName, commit)
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private toIntent(
    repoName: string,
    analysis: DiffAnalysisResult,
    commits: string[],
  ): EvolutionIntent {
    return {
      id: `us_${randomUUID().slice(0, 12)}`,
      type: "upstream_sync",
      description: `[${repoName}] ${analysis.description}`,
      targetFiles: analysis.targetFiles,
      evidence: [
        ...analysis.evidence,
        `Relevance: ${analysis.relevanceScore.toFixed(2)}`,
        `From ${commits.length} upstream commit(s)`,
      ],
      riskLevel: analysis.riskLevel,
      requiresHumanApproval: analysis.riskLevel !== "low",
      createdAt: Date.now(),
    }
  }
}
