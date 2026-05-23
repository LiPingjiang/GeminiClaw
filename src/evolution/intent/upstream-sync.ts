import { execSync } from "child_process"
import { randomUUID } from "crypto"
import type { EvolutionDB } from "../db.js"
import type { Intent } from "../types.js"
import type { ProviderRouter } from "../../providers/router.js"

export interface UpstreamRepo {
  name: string
  path: string
  baseCommit: string
}

export interface UpstreamSyncSourceConfig {
  db: EvolutionDB
  providerRouter: ProviderRouter
  repoRoot: string
  upstreamRepos?: UpstreamRepo[]
  model?: string
}

export class UpstreamSyncSource {
  private db: EvolutionDB
  private providerRouter: ProviderRouter
  private upstreamRepos: UpstreamRepo[]
  private model?: string

  constructor(config: UpstreamSyncSourceConfig) {
    this.db = config.db
    this.providerRouter = config.providerRouter
    this.upstreamRepos = config.upstreamRepos ?? []
    this.model = config.model
  }

  async check(): Promise<Intent[]> {
    const allIntents: Intent[] = []
    let anyNewCommits = false

    for (const repo of this.upstreamRepos) {
      try {
        const intents = await this.checkRepo(repo)
        allIntents.push(...intents)
        if (intents.length > 0) anyNewCommits = true
      } catch {
        // Silently skip inaccessible repos
      }
    }

    this.db.insertUpstreamCheck({
      newCommits: [],
      changedFiles: [],
      addedLines: 0,
      removedLines: 0,
      checkedAt: Date.now(),
      intentGenerated: anyNewCommits,
    })

    return allIntents
  }

  private async checkRepo(repo: UpstreamRepo): Promise<Intent[]> {
    let newCommitLines: string
    try {
      newCommitLines = execSync(
        `git -C "${repo.path}" log ${repo.baseCommit}..HEAD --oneline 2>/dev/null`,
        { encoding: "utf8", timeout: 10000 }
      ).trim()
    } catch {
      return []
    }

    if (!newCommitLines) return []

    const newCommits = newCommitLines.split("\n").filter(Boolean)

    let diffStat = `${newCommits.length} new commits`
    try {
      diffStat = execSync(
        `git -C "${repo.path}" diff ${repo.baseCommit}..HEAD --stat 2>/dev/null`,
        { encoding: "utf8", timeout: 10000 }
      ).trim()
    } catch { /* use fallback */ }

    const prompt = `You are analyzing upstream changes in the "${repo.name}" project to find improvements worth adopting in GeminiClaw (a TypeScript agent runtime).

New commits (${newCommits.length}):
${newCommits.slice(0, 20).join("\n")}

Diff summary:
${diffStat.slice(0, 2000)}

Return a JSON array of improvement intents (empty array [] if nothing relevant). Each intent:
{"type":"upstream_sync"|"performance"|"behavior_fix","description":"what to adopt and why","targetFiles":["src/..."],"riskLevel":"low"|"medium"|"high","evidence":["commit or reason"]}

Only include clearly beneficial and applicable changes. Return [] if nothing is relevant.`

    let parsed: Array<{
      type: Intent["type"]
      description: string
      targetFiles: string[]
      riskLevel: Intent["riskLevel"]
      evidence: string[]
    }> = []

    try {
      const response = await this.providerRouter.chat(
        [{ role: "user", content: prompt }],
        { model: this.model }
      )
      const match = response.content.match(/\[[\s\S]*\]/)
      if (match) parsed = JSON.parse(match[0])
    } catch {
      return []
    }

    const now = Date.now()
    return parsed.map(item => ({
      id: randomUUID(),
      type: item.type,
      description: item.description,
      targetFiles: item.targetFiles ?? [],
      evidence: item.evidence ?? [],
      riskLevel: item.riskLevel ?? "medium",
      status: "pending" as const,
      createdAt: now,
      updatedAt: now,
    }))
  }
}
