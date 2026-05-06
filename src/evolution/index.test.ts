// src/evolution/index.test.ts
// Integration tests for EvolutionEngine — covers all runOnce() branches.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { EvolutionEngine } from "./index.js"
import type { EvolutionDB } from "./db.js"
import type { ProviderRouter } from "../providers/router.js"
import type {
  Intent,
  MutationResult,
  ValidationResult,
  SwitchResult,
} from "./types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

function makeIntent(overrides?: Partial<Intent>): Intent {
  return {
    id: "intent-test-1",
    type: "behavior_fix",
    description: "Fix greeting response",
    targetFiles: ["src/server/routes/chat.ts"],
    evidence: [],
    riskLevel: "low",
    requiresHumanApproval: false,
    status: "pending",
    whyNow: "users complain",
    discoveredContext: "trace analysis",
    snoozeCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeMockDb(intents: Intent[] = []): Partial<EvolutionDB> {
  return {
    // Only return intents for 'pending' status queries; recovery queries (in_progress/validating) return []
    listIntents: vi.fn().mockImplementation((filter?: { status?: string }) => {
      if (!filter?.status || filter.status === "pending") return intents
      return []
    }),
    updateIntentStatus: vi.fn(),
    countTraces: vi.fn().mockReturnValue(0),
    getSlotState: vi.fn().mockReturnValue(null),
    upsertSlotState: vi.fn(),
    insertPendingReview: vi.fn(),
    getPendingReview: vi.fn().mockReturnValue(null),
    updatePendingReview: vi.fn(),
    getIntent: vi.fn().mockReturnValue(null),
    getLastEvolutionRecord: vi.fn().mockReturnValue(null),
    getLastUpstreamCheck: vi.fn().mockReturnValue(null),
    insertUpstreamCheck: vi.fn(),
    insertIntent: vi.fn(),
    getRecentTraces: vi.fn().mockReturnValue([]),
    getFailureRate: vi.fn().mockReturnValue(0),
    getEvolutionCountForFile: vi.fn().mockReturnValue(0),
    insertEvolutionRecord: vi.fn(),
  }
}

let tmpDirs: string[] = []

function makeEngine(db: Partial<EvolutionDB>): EvolutionEngine {
  const repoRoot = mkdtempSync(join(tmpdir(), "evolution-engine-test-"))
  tmpDirs.push(repoRoot)

  const mockRouter: ProviderRouter = {
    chat: vi.fn().mockResolvedValue({ content: "ok", model: "mock" }),
    stream: vi.fn(),
  } as unknown as ProviderRouter

  return new EvolutionEngine({
    db: db as EvolutionDB,
    providerRouter: mockRouter,
    repoRoot,
    logger: mockLogger,
  })
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  tmpDirs = []
})

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs = []
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EvolutionEngine.runOnce()", () => {
  // -------------------------------------------------------------------------
  // 1. No pending intents
  // -------------------------------------------------------------------------
  it("returns skipped when there are no pending intents", async () => {
    const db = makeMockDb([])
    const engine = makeEngine(db)

    const result = await engine.runOnce()

    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe("no pending intents")
    expect(result.validationResults).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // 2. CircuitBreaker blocks evolution
  // -------------------------------------------------------------------------
  it("returns skipped when CircuitBreaker blocks evolution", async () => {
    const intent = makeIntent()
    const db = makeMockDb([intent])
    const engine = makeEngine(db)

    vi.spyOn(engine.getCircuitBreaker(), "canEvolve").mockReturnValue({
      allowed: false,
      reason: "circuit_open",
    })

    const result = await engine.runOnce()

    expect(result.skipped).toBe(true)
    expect(result.skipReason).toContain("CircuitBreaker blocked")
    expect(result.skipReason).toContain("circuit_open")
    expect(result.intentId).toBe(intent.id)
    expect(db.updateIntentStatus).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 3. createEvolutionBranch fails
  // -------------------------------------------------------------------------
  it("rejects intent when createEvolutionBranch throws", async () => {
    const intent = makeIntent()
    const db = makeMockDb([intent])
    const engine = makeEngine(db)

    vi.spyOn(engine.getCircuitBreaker(), "canEvolve").mockReturnValue({
      allowed: true,
    })
    vi.spyOn(engine.getSwitcher(), "createEvolutionBranch").mockImplementation(() => {
      throw new Error("git checkout failed")
    })

    const result = await engine.runOnce()

    expect(result.skipped).toBe(false)
    expect(result.skipReason).toContain("Failed to create branch")
    expect(result.skipReason).toContain("git checkout failed")
    expect(db.updateIntentStatus).toHaveBeenCalledWith(intent.id, "in_progress")
    expect(db.updateIntentStatus).toHaveBeenCalledWith(intent.id, "rejected")
  })

  // -------------------------------------------------------------------------
  // 4. Mutation fails
  // -------------------------------------------------------------------------
  it("rejects intent when mutation fails", async () => {
    const intent = makeIntent()
    const db = makeMockDb([intent])
    const engine = makeEngine(db)

    vi.spyOn(engine.getCircuitBreaker(), "canEvolve").mockReturnValue({
      allowed: true,
    })
    vi.spyOn(engine.getSwitcher(), "createEvolutionBranch").mockReturnValue(
      "evolution/intent-test-1"
    )

    const failedMutation: MutationResult = {
      success: false,
      error: "diff failed",
      confidence: { score: 0, reason: "no diff", uncertainties: [] },
      changedFiles: [],
      rounds: 1,
    }
    vi.spyOn(engine.getMutator(), "mutate").mockResolvedValue(failedMutation)

    const result = await engine.runOnce()

    expect(result.skipped).toBe(false)
    expect(result.skipReason).toContain("Mutation failed")
    expect(result.skipReason).toContain("diff failed")
    expect(result.mutationResult).toBe(failedMutation)
    expect(db.updateIntentStatus).toHaveBeenCalledWith(intent.id, "rejected")
  })

  // -------------------------------------------------------------------------
  // 5. Low confidence triggers risk escalation
  // -------------------------------------------------------------------------
  it("escalates riskLevel from low to medium when confidence is below threshold", async () => {
    const intent = makeIntent({ riskLevel: "low", requiresHumanApproval: false })
    const db = makeMockDb([intent])
    const engine = makeEngine(db)

    vi.spyOn(engine.getCircuitBreaker(), "canEvolve").mockReturnValue({
      allowed: true,
    })
    vi.spyOn(engine.getSwitcher(), "createEvolutionBranch").mockReturnValue(
      "evolution/intent-test-1"
    )

    // Low confidence: score 0.5 < threshold 0.7
    const lowConfMutation: MutationResult = {
      success: true,
      confidence: { score: 0.5, reason: "unsure", uncertainties: ["might break"] },
      changedFiles: ["src/server/routes/chat.ts"],
      rounds: 1,
    }
    vi.spyOn(engine.getMutator(), "mutate").mockResolvedValue(lowConfMutation)

    // Level 1 validation passes
    const level1Pass: ValidationResult = {
      level: 1,
      passed: true,
      details: "all good",
      durationMs: 100,
    }
    vi.spyOn(engine.getValidator(), "validate").mockResolvedValue(level1Pass)

    // countTraces < 3 → no Level 2
    ;(db.countTraces as ReturnType<typeof vi.fn>).mockReturnValue(0)

    // After escalation, riskLevel=medium → needs approval
    const result = await engine.runOnce()

    expect(result.skipped).toBe(false)
    // Medium risk → needs approval path
    expect(result.skipReason).toContain("Needs approval")
    expect(result.skipReason).toContain("medium")
    // insertPendingReview should be called with medium riskLevel
    expect(db.insertPendingReview).toHaveBeenCalledWith(
      expect.objectContaining({ riskLevel: "medium" })
    )
    expect(db.updateIntentStatus).toHaveBeenCalledWith(intent.id, "approved")
  })

  // -------------------------------------------------------------------------
  // 6. Level 1 validation fails
  // -------------------------------------------------------------------------
  it("rejects intent when Level 1 validation fails", async () => {
    const intent = makeIntent()
    const db = makeMockDb([intent])
    const engine = makeEngine(db)

    vi.spyOn(engine.getCircuitBreaker(), "canEvolve").mockReturnValue({
      allowed: true,
    })
    vi.spyOn(engine.getSwitcher(), "createEvolutionBranch").mockReturnValue(
      "evolution/intent-test-1"
    )

    const goodMutation: MutationResult = {
      success: true,
      confidence: { score: 0.9, reason: "confident", uncertainties: [] },
      changedFiles: ["src/server/routes/chat.ts"],
      rounds: 1,
    }
    vi.spyOn(engine.getMutator(), "mutate").mockResolvedValue(goodMutation)

    const level1Fail: ValidationResult = {
      level: 1,
      passed: false,
      reason: "build failed",
      details: "tsc error",
      durationMs: 200,
    }
    vi.spyOn(engine.getValidator(), "validate").mockResolvedValue(level1Fail)

    const result = await engine.runOnce()

    expect(result.skipped).toBe(false)
    expect(result.skipReason).toBeUndefined()
    expect(result.validationResults).toHaveLength(1)
    expect(result.validationResults[0].passed).toBe(false)
    expect(db.updateIntentStatus).toHaveBeenCalledWith(intent.id, "rejected")
  })

  // -------------------------------------------------------------------------
  // 7. Low-risk auto-switch succeeds
  // -------------------------------------------------------------------------
  it("auto-switches and marks applied for low-risk intent", async () => {
    const intent = makeIntent({ riskLevel: "low", requiresHumanApproval: false })
    const db = makeMockDb([intent])
    const engine = makeEngine(db)

    vi.spyOn(engine.getCircuitBreaker(), "canEvolve").mockReturnValue({
      allowed: true,
    })
    vi.spyOn(engine.getSwitcher(), "createEvolutionBranch").mockReturnValue(
      "evolution/intent-test-1"
    )

    const goodMutation: MutationResult = {
      success: true,
      confidence: { score: 0.95, reason: "high confidence", uncertainties: [] },
      changedFiles: ["src/server/routes/chat.ts"],
      rounds: 1,
    }
    vi.spyOn(engine.getMutator(), "mutate").mockResolvedValue(goodMutation)

    const level1Pass: ValidationResult = {
      level: 1,
      passed: true,
      details: "build ok",
      durationMs: 150,
    }
    vi.spyOn(engine.getValidator(), "validate").mockResolvedValue(level1Pass)

    ;(db.countTraces as ReturnType<typeof vi.fn>).mockReturnValue(0)

    const switchSuccess: SwitchResult = {
      success: true,
      fromSlot: "b",
      toSlot: "a",
    }
    vi.spyOn(engine.getSwitcher(), "switch").mockResolvedValue(switchSuccess)

    const startMonitoringSpy = vi.spyOn(engine.getCircuitBreaker(), "startMonitoring")

    const result = await engine.runOnce()

    expect(result.skipped).toBe(false)
    expect(result.switchResult).toBe(switchSuccess)
    expect(result.validationResults).toHaveLength(1)
    expect(db.updateIntentStatus).toHaveBeenCalledWith(intent.id, "applied")
    expect(startMonitoringSpy).toHaveBeenCalledWith(intent.id)
  })

  // -------------------------------------------------------------------------
  // 8. Low-risk auto-switch fails
  // -------------------------------------------------------------------------
  it("rejects intent when auto-switch fails", async () => {
    const intent = makeIntent({ riskLevel: "low", requiresHumanApproval: false })
    const db = makeMockDb([intent])
    const engine = makeEngine(db)

    vi.spyOn(engine.getCircuitBreaker(), "canEvolve").mockReturnValue({
      allowed: true,
    })
    vi.spyOn(engine.getSwitcher(), "createEvolutionBranch").mockReturnValue(
      "evolution/intent-test-1"
    )

    const goodMutation: MutationResult = {
      success: true,
      confidence: { score: 0.9, reason: "confident", uncertainties: [] },
      changedFiles: ["src/server/routes/chat.ts"],
      rounds: 1,
    }
    vi.spyOn(engine.getMutator(), "mutate").mockResolvedValue(goodMutation)

    const level1Pass: ValidationResult = {
      level: 1,
      passed: true,
      details: "ok",
      durationMs: 100,
    }
    vi.spyOn(engine.getValidator(), "validate").mockResolvedValue(level1Pass)

    ;(db.countTraces as ReturnType<typeof vi.fn>).mockReturnValue(0)

    const switchFail: SwitchResult = {
      success: false,
      fromSlot: "b",
      toSlot: "a",
      error: "merge conflict",
    }
    vi.spyOn(engine.getSwitcher(), "switch").mockResolvedValue(switchFail)
    const startMonitoringSpy = vi.spyOn(engine.getCircuitBreaker(), "startMonitoring")

    const result = await engine.runOnce()

    expect(result.skipped).toBe(false)
    expect(result.switchResult).toBe(switchFail)
    expect(db.updateIntentStatus).toHaveBeenCalledWith(intent.id, "rejected")
    expect(startMonitoringSpy).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 9. Medium/high risk requires approval
  // -------------------------------------------------------------------------
  it("inserts pending review and returns needsApproval for medium-risk intent", async () => {
    const intent = makeIntent({ riskLevel: "medium", requiresHumanApproval: false })
    const db = makeMockDb([intent])
    const engine = makeEngine(db)

    vi.spyOn(engine.getCircuitBreaker(), "canEvolve").mockReturnValue({
      allowed: true,
    })
    vi.spyOn(engine.getSwitcher(), "createEvolutionBranch").mockReturnValue(
      "evolution/intent-test-1"
    )

    const goodMutation: MutationResult = {
      success: true,
      confidence: { score: 0.85, reason: "ok", uncertainties: [] },
      changedFiles: ["src/server/routes/chat.ts"],
      rounds: 1,
    }
    vi.spyOn(engine.getMutator(), "mutate").mockResolvedValue(goodMutation)

    const level1Pass: ValidationResult = {
      level: 1,
      passed: true,
      details: "ok",
      durationMs: 100,
    }
    vi.spyOn(engine.getValidator(), "validate").mockResolvedValue(level1Pass)

    ;(db.countTraces as ReturnType<typeof vi.fn>).mockReturnValue(0)

    const result = await engine.runOnce()

    expect(result.skipped).toBe(false)
    expect(result.skipReason).toContain("Needs approval")
    expect(result.skipReason).toContain("medium")
    expect(db.insertPendingReview).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: intent.id,
        riskLevel: "medium",
        status: "pending",
      })
    )
    expect(db.updateIntentStatus).toHaveBeenCalledWith(intent.id, "approved")
    // switch should NOT be called — only insertPendingReview should have been called
    expect(db.insertPendingReview).toHaveBeenCalledOnce()
  })

  // -------------------------------------------------------------------------
  // 10. Level 2 validation is triggered when traces >= 3
  // -------------------------------------------------------------------------
  it("triggers Level 2 validation when trace count >= 3", async () => {
    const intent = makeIntent({ riskLevel: "low", requiresHumanApproval: false })
    const db = makeMockDb([intent])
    const engine = makeEngine(db)

    vi.spyOn(engine.getCircuitBreaker(), "canEvolve").mockReturnValue({
      allowed: true,
    })
    vi.spyOn(engine.getSwitcher(), "createEvolutionBranch").mockReturnValue(
      "evolution/intent-test-1"
    )

    const goodMutation: MutationResult = {
      success: true,
      confidence: { score: 0.9, reason: "confident", uncertainties: [] },
      changedFiles: ["src/server/routes/chat.ts"],
      rounds: 1,
    }
    vi.spyOn(engine.getMutator(), "mutate").mockResolvedValue(goodMutation)

    const level1Pass: ValidationResult = {
      level: 1,
      passed: true,
      details: "ok",
      durationMs: 100,
    }
    vi.spyOn(engine.getValidator(), "validate").mockResolvedValue(level1Pass)

    // 3 traces → Level 2 should be triggered
    ;(db.countTraces as ReturnType<typeof vi.fn>).mockReturnValue(3)

    const level2Pass: ValidationResult = {
      level: 2,
      passed: true,
      skipped: false,
      details: "behavior ok",
      durationMs: 300,
    }
    const validateLevel2Spy = vi
      .spyOn(engine.getValidator(), "validateLevel2")
      .mockResolvedValue(level2Pass)

    const switchSuccess: SwitchResult = {
      success: true,
      fromSlot: "b",
      toSlot: "a",
    }
    vi.spyOn(engine.getSwitcher(), "switch").mockResolvedValue(switchSuccess)
    vi.spyOn(engine.getCircuitBreaker(), "startMonitoring")

    const result = await engine.runOnce()

    expect(validateLevel2Spy).toHaveBeenCalledOnce()
    expect(result.validationResults).toHaveLength(2)
    expect(result.validationResults[1]).toBe(level2Pass)
    expect(db.updateIntentStatus).toHaveBeenCalledWith(intent.id, "applied")
  })

  // -------------------------------------------------------------------------
  // 11. Level 2 validation fails
  // -------------------------------------------------------------------------
  it("rejects intent when Level 2 validation fails (not skipped)", async () => {
    const intent = makeIntent({ riskLevel: "low", requiresHumanApproval: false })
    const db = makeMockDb([intent])
    const engine = makeEngine(db)

    vi.spyOn(engine.getCircuitBreaker(), "canEvolve").mockReturnValue({
      allowed: true,
    })
    vi.spyOn(engine.getSwitcher(), "createEvolutionBranch").mockReturnValue(
      "evolution/intent-test-1"
    )

    const goodMutation: MutationResult = {
      success: true,
      confidence: { score: 0.9, reason: "confident", uncertainties: [] },
      changedFiles: ["src/server/routes/chat.ts"],
      rounds: 1,
    }
    vi.spyOn(engine.getMutator(), "mutate").mockResolvedValue(goodMutation)

    const level1Pass: ValidationResult = {
      level: 1,
      passed: true,
      details: "ok",
      durationMs: 100,
    }
    vi.spyOn(engine.getValidator(), "validate").mockResolvedValue(level1Pass)

    ;(db.countTraces as ReturnType<typeof vi.fn>).mockReturnValue(3)

    const level2Fail: ValidationResult = {
      level: 2,
      passed: false,
      skipped: false,
      reason: "error rate too high",
      details: "behavior degraded",
      durationMs: 250,
    }
    vi.spyOn(engine.getValidator(), "validateLevel2").mockResolvedValue(level2Fail)

    const result = await engine.runOnce()

    expect(result.skipped).toBe(false)
    expect(result.validationResults).toHaveLength(2)
    expect(result.validationResults[1].passed).toBe(false)
    expect(db.updateIntentStatus).toHaveBeenCalledWith(intent.id, "rejected")
    // switch should NOT be called — insertPendingReview also should not be called
    expect(db.insertPendingReview).not.toHaveBeenCalled()
  })
})
