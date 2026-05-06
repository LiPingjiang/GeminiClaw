// src/evolution/switcher/switcher.ts
// Switcher: manages git branch flow for slot switching.
//
// Slot model (v2):
//   main branch = current running state (slot-A)
//   evolution/<intentId> branch = pending changes (slot-B)
//
// Switch flow:
//   1. git checkout main
//   2. git merge --squash <branchName>
//   3. git commit -m "evolution(<intentId>): <description>"
//   4. Record in evolution_history
//   5. Send SIGUSR1 to self (hot-reload), fallback to process.exit(0)
//
// Rollback flow:
//   1. Find last switch record in evolution_history
//   2. git revert HEAD --no-edit
//   3. Restart process

import { execSync, spawnSync } from "child_process"
import type { EvolutionDB } from "../db.js"
import type { Intent, SwitchResult } from "../types.js"
import type { Logger } from "../index.js"

// ---------------------------------------------------------------------------
// Switcher
// ---------------------------------------------------------------------------

export interface SwitcherParams {
  repoRoot: string
  db: EvolutionDB
  logger: Logger
}

export class Switcher {
  private repoRoot: string
  private db: EvolutionDB
  private logger: Logger

  constructor(params: SwitcherParams) {
    this.repoRoot = params.repoRoot
    this.db = params.db
    this.logger = params.logger
  }

  /**
   * Create a new evolution branch from the current main HEAD.
   * Returns the branch name.
   */
  createEvolutionBranch(intentId: string): string {
    const branchName = `evolution/${intentId}`
    this.logger.info("Creating evolution branch: %s", branchName)

    try {
      // Ensure we're on main first
      execSync("git checkout main", {
        cwd: this.repoRoot,
        timeout: 15_000,
        stdio: "pipe",
      })

      // Create and checkout new branch
      execSync(`git checkout -b ${JSON.stringify(branchName)}`, {
        cwd: this.repoRoot,
        timeout: 15_000,
        stdio: "pipe",
      })

      this.logger.info("Created branch %s", branchName)
      return branchName
    } catch (err) {
      throw new Error(`Failed to create evolution branch: ${(err as Error).message}`)
    }
  }

  /**
   * Switch: squash merge the evolution branch into main, then restart.
   * Records the switch in evolution_history.
   */
  async switch(branchName: string, intent: Intent): Promise<SwitchResult> {
    this.logger.info("Switching: merging %s into main", branchName)

    try {
      // Get list of changed files in the branch
      const changedFiles = this.getChangedFiles(branchName)

      // Checkout main
      execSync("git checkout main", {
        cwd: this.repoRoot,
        timeout: 15_000,
        stdio: "pipe",
      })

      // Squash merge
      execSync(`git merge --squash ${JSON.stringify(branchName)}`, {
        cwd: this.repoRoot,
        timeout: 30_000,
        stdio: "pipe",
      })

      // Commit
      const commitMsg = `evolution(${intent.id}): ${intent.description.slice(0, 72)}`
      execSync(`git commit -m ${JSON.stringify(commitMsg)}`, {
        cwd: this.repoRoot,
        timeout: 15_000,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "GeminiClaw Evolution",
          GIT_AUTHOR_EMAIL: "evolution@geminiclaw.local",
          GIT_COMMITTER_NAME: "GeminiClaw Evolution",
          GIT_COMMITTER_EMAIL: "evolution@geminiclaw.local",
        },
        stdio: "pipe",
      })

      // Record in DB
      this.db.insertEvolutionRecord({
        intentId: intent.id,
        type: "switch",
        fromSlot: "b",
        toSlot: "a",
        changedFiles,
        recordedAt: Date.now(),
      })

      this.logger.info("Switch committed. Scheduling restart...")

      const result: SwitchResult = {
        success: true,
        fromSlot: "b",
        toSlot: "a",
        intentId: intent.id,
      }

      // Schedule restart after a short delay so the response can be sent
      this.scheduleRestart()

      return result
    } catch (err) {
      const error = (err as Error).message
      this.logger.error("Switch failed: %s", error)
      return {
        success: false,
        fromSlot: "b",
        toSlot: "a",
        intentId: intent.id,
        error,
      }
    }
  }

  /**
   * Rollback: revert the last switch commit on main, then restart.
   */
  async rollback(): Promise<SwitchResult> {
    this.logger.info("Rolling back last evolution switch")

    try {
      // Find last switch record
      const history = this.db.listEvolutionHistory(10)
      const lastSwitch = history.find(r => r.type === "switch")

      if (!lastSwitch) {
        return {
          success: false,
          fromSlot: "a",
          toSlot: "b",
          error: "No switch record found to roll back",
        }
      }

      // Ensure we're on main
      execSync("git checkout main", {
        cwd: this.repoRoot,
        timeout: 15_000,
        stdio: "pipe",
      })

      // Revert the last commit
      execSync("git revert HEAD --no-edit", {
        cwd: this.repoRoot,
        timeout: 30_000,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "GeminiClaw Evolution",
          GIT_AUTHOR_EMAIL: "evolution@geminiclaw.local",
          GIT_COMMITTER_NAME: "GeminiClaw Evolution",
          GIT_COMMITTER_EMAIL: "evolution@geminiclaw.local",
        },
        stdio: "pipe",
      })

      // Record rollback
      this.db.insertEvolutionRecord({
        intentId: lastSwitch.intentId,
        type: "rollback",
        fromSlot: "a",
        toSlot: "b",
        changedFiles: lastSwitch.changedFiles,
        recordedAt: Date.now(),
      })

      this.logger.info("Rollback committed. Scheduling restart...")

      this.scheduleRestart()

      return {
        success: true,
        fromSlot: "a",
        toSlot: "b",
        intentId: lastSwitch.intentId,
      }
    } catch (err) {
      const error = (err as Error).message
      this.logger.error("Rollback failed: %s", error)
      return {
        success: false,
        fromSlot: "a",
        toSlot: "b",
        error,
      }
    }
  }

  /**
   * Get the current git branch name.
   */
  getCurrentBranch(): string {
    try {
      const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: this.repoRoot,
        encoding: "utf-8",
        timeout: 5_000,
      })
      return result.stdout.trim()
    } catch {
      return "unknown"
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getChangedFiles(branchName: string): string[] {
    try {
      const result = spawnSync(
        "git",
        ["diff", "--name-only", "main", branchName],
        {
          cwd: this.repoRoot,
          encoding: "utf-8",
          timeout: 10_000,
        }
      )
      if (result.status !== 0) return []
      return result.stdout.trim().split("\n").filter(Boolean)
    } catch {
      return []
    }
  }

  private scheduleRestart(): void {
    setTimeout(() => {
      this.logger.info("Sending SIGUSR1 for hot-reload...")
      try {
        process.kill(process.pid, "SIGUSR1")
      } catch {
        // SIGUSR1 not handled — fall back to graceful exit
        this.logger.info("SIGUSR1 not handled, using process.exit(0)")
        setTimeout(() => process.exit(0), 100)
      }
    }, 500)
  }
}
