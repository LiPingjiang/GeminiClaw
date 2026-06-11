import { join } from "path"
import os from "os"

/**
 * Centralized resolver for all memory storage paths.
 *
 * Layout:
 *   {root}/AGENT.md                              ← global fixed (system prompt, never compacted)
 *   {root}/memory/global/MEMORY.md               ← global non-fixed long-term
 *   {root}/memory/global/daily/{date}.md         ← global non-fixed daily
 *   {root}/agents/{agentId}/AGENT.md             ← per-agent fixed (identity, never compacted)
 *   {root}/agents/{agentId}/MEMORY.md            ← per-agent non-fixed long-term
 *   {root}/agents/{agentId}/daily/{date}.md      ← per-agent non-fixed daily
 *
 * Default root: ~/.gemeniclaw
 */
export class MemoryPaths {
  constructor(private readonly root: string = join(os.homedir(), ".gemeniclaw")) {}

  // ── Global fixed (system prompt, never compacted) ──────────────────────
  globalAgentMd(): string {
    return join(this.root, "AGENT.md")
  }

  // ── Global non-fixed (compressible long-term + daily) ──────────────────
  globalMemoryMd(): string {
    return join(this.root, "memory", "global", "MEMORY.md")
  }

  globalDaily(date: string): string {
    return join(this.root, "memory", "global", "daily", `${date}.md`)
  }

  globalDailyDir(): string {
    return join(this.root, "memory", "global", "daily")
  }

  // ── Per-agent fixed (agent identity, never compacted) ──────────────────
  agentAgentMd(agentId: string): string {
    return join(this.root, "agents", agentId, "AGENT.md")
  }

  // ── Per-agent non-fixed (compressible long-term + daily) ───────────────
  agentMemoryMd(agentId: string): string {
    return join(this.root, "agents", agentId, "MEMORY.md")
  }

  agentDaily(agentId: string, date: string): string {
    return join(this.root, "agents", agentId, "daily", `${date}.md`)
  }

  agentDailyDir(agentId: string): string {
    return join(this.root, "agents", agentId, "daily")
  }

  agentDir(agentId: string): string {
    return join(this.root, "agents", agentId)
  }

  /** Expose the root for callers that need to construct ad-hoc paths. */
  getRoot(): string {
    return this.root
  }
}
