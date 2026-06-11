/**
 * SlotManager — Manages the twin-slot lifecycle.
 *
 * Responsible for:
 * - Tracking which slot is active/standby
 * - Creating evolution branches on the standby slot
 * - Executing the switch (squash-merge standby→active)
 * - Rollback (revert last switch)
 * - Branch cleanup
 */

import { randomUUID } from "crypto"
import type {
  SlotId,
  SlotState,
  SlotStatus,
  EvolutionIntent,
  EvolutionRecord,
} from "./types.js"

export interface GitOps {
  /** Get current branch name */
  getCurrentBranch(): string
  /** Create and checkout a new branch from current HEAD */
  createBranch(name: string): void
  /** Checkout an existing branch */
  checkout(branch: string): void
  /** Squash-merge a branch into the current branch */
  squashMerge(branch: string): void
  /** Commit staged changes */
  commit(message: string): void
  /** Get list of files changed between two branches */
  diffFiles(baseBranch: string, targetBranch: string): string[]
  /** Revert last commit */
  revertHead(): void
  /** Delete a branch */
  deleteBranch(branch: string): void
  /** Get HEAD commit hash */
  getHeadCommit(): string
  /** Stage all changes */
  stageAll(): void
  /** Discard ALL uncommitted changes (tracked + staged) in the working tree */
  discardChanges(): void
}

export interface SlotManagerConfig {
  /** Main branch name (active slot) */
  mainBranch?: string
}

export class SlotManager {
  private git: GitOps
  private config: Required<SlotManagerConfig>
  private slots: Map<SlotId, SlotState> = new Map()
  private history: EvolutionRecord[] = []

  constructor(git: GitOps, config: SlotManagerConfig = {}) {
    this.git = git
    this.config = {
      mainBranch: config.mainBranch ?? "main",
    }

    // Initialize slot states
    this.slots.set("a", {
      id: "a",
      status: "active",
      branch: this.config.mainBranch,
      updatedAt: Date.now(),
    })
    this.slots.set("b", {
      id: "b",
      status: "standby",
      branch: "",
      updatedAt: Date.now(),
    })
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /** Get the active slot */
  getActive(): SlotState {
    return this.slots.get("a")!
  }

  /** Get the standby slot */
  getStandby(): SlotState {
    return this.slots.get("b")!
  }

  /** Get a slot by ID */
  getSlot(id: SlotId): SlotState {
    return this.slots.get(id)!
  }

  /** Check if the standby slot is available for evolution */
  isStandbyAvailable(): boolean {
    const standby = this.getStandby()
    return standby.status === "standby"
  }

  /** Get evolution history */
  getHistory(): EvolutionRecord[] {
    return [...this.history]
  }

  // ── Evolution Lifecycle ──────────────────────────────────────────────────

  /**
   * Begin an evolution: create a branch on the standby slot.
   * Returns the branch name.
   */
  beginEvolution(intent: EvolutionIntent): string {
    const standby = this.getStandby()
    if (standby.status !== "standby") {
      throw new Error(
        `Standby slot is not available (status: ${standby.status})`,
      )
    }

    const branchName = `evolution/${intent.id}`

    // Ensure we're on main
    this.git.checkout(this.config.mainBranch)
    // Create evolution branch
    this.git.createBranch(branchName)

    // Update slot state
    this.updateSlot("b", {
      status: "evolving",
      branch: branchName,
      currentIntentId: intent.id,
    })

    return branchName
  }

  /**
   * Mark evolution as in validation phase.
   */
  markValidating(intentId: string): void {
    const standby = this.getStandby()
    if (standby.currentIntentId !== intentId) {
      throw new Error(`Intent ${intentId} not found on standby slot`)
    }
    this.updateSlot("b", { status: "validating" })
  }

  /**
   * Mark evolution as failed. Standby returns to standby status.
   */
  markFailed(intentId: string): void {
    const standby = this.getStandby()
    if (standby.currentIntentId !== intentId) {
      throw new Error(`Intent ${intentId} not found on standby slot`)
    }

    // Cleanup: discard any uncommitted mutation changes so they cannot leak
    // into main's working tree, then go back to main and delete the branch.
    try {
      this.git.discardChanges()
    } catch {
      // best-effort
    }
    this.git.checkout(this.config.mainBranch)
    try {
      this.git.deleteBranch(standby.branch)
    } catch {
      // branch may not exist
    }

    this.updateSlot("b", {
      status: "standby",
      branch: "",
      currentIntentId: undefined,
    })

    this.recordHistory({
      intentId,
      action: "mutation",
      success: false,
      fromSlot: "b",
      toSlot: "b",
      changedFiles: [],
    })
  }

  /**
   * Execute the switch: squash-merge standby branch into main.
   * After switch, standby becomes available again.
   */
  executeSwitch(intent: EvolutionIntent): EvolutionRecord {
    const standby = this.getStandby()
    if (
      standby.status !== "validating" &&
      standby.status !== "evolving"
    ) {
      throw new Error(
        `Cannot switch: standby is in ${standby.status} state`,
      )
    }

    const branchName = standby.branch
    const changedFiles = this.git.diffFiles(this.config.mainBranch, branchName)

    // Checkout main and squash-merge
    this.git.checkout(this.config.mainBranch)
    this.git.squashMerge(branchName)

    // Commit
    const commitMsg = `evolution(${intent.id}): ${intent.description.slice(0, 72)}`
    this.git.commit(commitMsg)

    // Get new head commit
    const newCommit = this.git.getHeadCommit()

    // Clean up evolution branch
    try {
      this.git.deleteBranch(branchName)
    } catch {
      // non-critical
    }

    // Update slot states
    this.updateSlot("a", { lastCommit: newCommit })
    this.updateSlot("b", {
      status: "standby",
      branch: "",
      currentIntentId: undefined,
    })

    const record = this.recordHistory({
      intentId: intent.id,
      action: "switch",
      success: true,
      fromSlot: "b",
      toSlot: "a",
      changedFiles,
    })

    return record
  }

  /**
   * Rollback: revert the last switch on main.
   */
  rollback(): EvolutionRecord {
    const lastSwitch = this.history
      .filter((r) => r.action === "switch" && r.success)
      .pop()

    if (!lastSwitch) {
      throw new Error("No successful switch found to rollback")
    }

    // Ensure on main
    this.git.checkout(this.config.mainBranch)
    this.git.revertHead()

    const newCommit = this.git.getHeadCommit()
    this.updateSlot("a", { lastCommit: newCommit })

    const record = this.recordHistory({
      intentId: lastSwitch.intentId,
      action: "rollback",
      success: true,
      fromSlot: "a",
      toSlot: "a",
      changedFiles: lastSwitch.changedFiles,
    })

    return record
  }

  /**
   * Abort current evolution without switch.
   */
  abortEvolution(): void {
    const standby = this.getStandby()
    if (standby.status === "standby") return

    // Discard uncommitted mutation changes before switching back to main,
    // otherwise a failed/aborted (or dry-run) cycle pollutes main's tree.
    try {
      this.git.discardChanges()
    } catch {
      // best-effort
    }
    this.git.checkout(this.config.mainBranch)
    if (standby.branch) {
      try {
        this.git.deleteBranch(standby.branch)
      } catch {
        // branch may already be deleted
      }
    }

    this.updateSlot("b", {
      status: "standby",
      branch: "",
      currentIntentId: undefined,
    })
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private updateSlot(
    id: SlotId,
    patch: Partial<Omit<SlotState, "id">>,
  ): void {
    const current = this.slots.get(id)!
    this.slots.set(id, {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    })
  }

  private recordHistory(
    params: Omit<EvolutionRecord, "id" | "timestamp">,
  ): EvolutionRecord {
    const record: EvolutionRecord = {
      id: `evo_${randomUUID().slice(0, 8)}`,
      ...params,
      timestamp: Date.now(),
    }
    this.history.push(record)
    return record
  }
}
