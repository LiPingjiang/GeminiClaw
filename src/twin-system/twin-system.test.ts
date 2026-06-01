/**
 * Twin-System Tests
 *
 * Covers:
 * - SlotManager: slot lifecycle, branch creation, switch, rollback, abort
 * - SafetyGuard: protected paths, frequency limits, circuit breaker, risk gating
 * - EvolutionPipeline: end-to-end flow, abort scenarios, approval gates
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { SlotManager, type GitOps } from "./slot-manager.js"
import { SafetyGuard } from "./safety-guard.js"
import { EvolutionPipeline, type Mutator, type Validator } from "./evolution-pipeline.js"
import type { EvolutionIntent, ValidationResult } from "./types.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockGitOps(): GitOps {
  return {
    getCurrentBranch: vi.fn(() => "main"),
    createBranch: vi.fn(),
    checkout: vi.fn(),
    squashMerge: vi.fn(),
    commit: vi.fn(),
    diffFiles: vi.fn(() => ["src/foo.ts", "src/bar.ts"]),
    revertHead: vi.fn(),
    deleteBranch: vi.fn(),
    getHeadCommit: vi.fn(() => "abc123"),
    stageAll: vi.fn(),
  }
}

function createIntent(overrides: Partial<EvolutionIntent> = {}): EvolutionIntent {
  return {
    id: "test-intent-001",
    type: "behavior_fix",
    description: "Fix response format",
    targetFiles: ["src/server/routes.ts"],
    evidence: ["User reported wrong format"],
    riskLevel: "low",
    requiresHumanApproval: false,
    createdAt: Date.now(),
    ...overrides,
  }
}

function createMockMutator(result?: Partial<ReturnType<Mutator["mutate"]> extends Promise<infer R> ? R : never>): Mutator {
  return {
    mutate: vi.fn(async () => ({
      success: true,
      changedFiles: ["src/server/routes.ts"],
      confidence: { score: 0.85, reason: "High confidence fix", uncertainties: [] },
      rounds: 1,
      ...result,
    })),
  }
}

function createMockValidator(result?: Partial<ValidationResult>): Validator {
  return {
    validate: vi.fn(async () => ({
      level: 1 as const,
      passed: true,
      details: "All tests pass",
      durationMs: 1200,
      ...result,
    })),
  }
}

// ── SlotManager ──────────────────────────────────────────────────────────────

describe("SlotManager", () => {
  let git: GitOps
  let sm: SlotManager

  beforeEach(() => {
    git = createMockGitOps()
    sm = new SlotManager(git)
  })

  describe("initialization", () => {
    it("starts with slot A active, slot B standby", () => {
      expect(sm.getActive().status).toBe("active")
      expect(sm.getActive().id).toBe("a")
      expect(sm.getStandby().status).toBe("standby")
      expect(sm.getStandby().id).toBe("b")
    })

    it("standby is available", () => {
      expect(sm.isStandbyAvailable()).toBe(true)
    })
  })

  describe("beginEvolution", () => {
    it("creates an evolution branch and transitions standby to evolving", () => {
      const intent = createIntent()
      const branch = sm.beginEvolution(intent)

      expect(branch).toBe("evolution/test-intent-001")
      expect(git.checkout).toHaveBeenCalledWith("main")
      expect(git.createBranch).toHaveBeenCalledWith("evolution/test-intent-001")
      expect(sm.getStandby().status).toBe("evolving")
      expect(sm.getStandby().branch).toBe(branch)
      expect(sm.getStandby().currentIntentId).toBe(intent.id)
    })

    it("throws if standby is not available", () => {
      const intent = createIntent()
      sm.beginEvolution(intent)
      // standby is now evolving
      expect(() => sm.beginEvolution(createIntent({ id: "another" }))).toThrow(
        /not available/,
      )
    })
  })

  describe("markValidating", () => {
    it("transitions standby to validating", () => {
      const intent = createIntent()
      sm.beginEvolution(intent)
      sm.markValidating(intent.id)
      expect(sm.getStandby().status).toBe("validating")
    })

    it("throws for wrong intent ID", () => {
      const intent = createIntent()
      sm.beginEvolution(intent)
      expect(() => sm.markValidating("wrong-id")).toThrow(/not found/)
    })
  })

  describe("markFailed", () => {
    it("resets standby to standby state and cleans up branch", () => {
      const intent = createIntent()
      sm.beginEvolution(intent)
      sm.markFailed(intent.id)

      expect(sm.getStandby().status).toBe("standby")
      expect(sm.getStandby().branch).toBe("")
      expect(sm.getStandby().currentIntentId).toBeUndefined()
      expect(git.checkout).toHaveBeenCalledWith("main")
      expect(git.deleteBranch).toHaveBeenCalledWith("evolution/test-intent-001")
    })

    it("records failure in history", () => {
      const intent = createIntent()
      sm.beginEvolution(intent)
      sm.markFailed(intent.id)

      const history = sm.getHistory()
      expect(history).toHaveLength(1)
      expect(history[0].success).toBe(false)
      expect(history[0].action).toBe("mutation")
    })
  })

  describe("executeSwitch", () => {
    it("squash-merges and resets standby", () => {
      const intent = createIntent()
      sm.beginEvolution(intent)
      sm.markValidating(intent.id)

      const record = sm.executeSwitch(intent)

      expect(git.checkout).toHaveBeenCalledWith("main")
      expect(git.squashMerge).toHaveBeenCalledWith("evolution/test-intent-001")
      expect(git.commit).toHaveBeenCalled()
      expect(git.deleteBranch).toHaveBeenCalledWith("evolution/test-intent-001")

      expect(record.success).toBe(true)
      expect(record.action).toBe("switch")
      expect(record.changedFiles).toEqual(["src/foo.ts", "src/bar.ts"])
      expect(sm.getStandby().status).toBe("standby")
      expect(sm.getActive().lastCommit).toBe("abc123")
    })

    it("throws if standby is in wrong state", () => {
      const intent = createIntent()
      expect(() => sm.executeSwitch(intent)).toThrow(/Cannot switch/)
    })
  })

  describe("rollback", () => {
    it("reverts the last successful switch", () => {
      const intent = createIntent()
      sm.beginEvolution(intent)
      sm.markValidating(intent.id)
      sm.executeSwitch(intent)

      const record = sm.rollback()
      expect(git.revertHead).toHaveBeenCalled()
      expect(record.success).toBe(true)
      expect(record.action).toBe("rollback")
    })

    it("throws if no switch found to rollback", () => {
      expect(() => sm.rollback()).toThrow(/No successful switch/)
    })
  })

  describe("abortEvolution", () => {
    it("resets standby without merging", () => {
      const intent = createIntent()
      sm.beginEvolution(intent)
      sm.abortEvolution()

      expect(sm.getStandby().status).toBe("standby")
      expect(git.checkout).toHaveBeenCalledWith("main")
      expect(git.deleteBranch).toHaveBeenCalledWith("evolution/test-intent-001")
    })

    it("is a no-op if standby is already in standby state", () => {
      sm.abortEvolution()
      expect(sm.getStandby().status).toBe("standby")
    })
  })
})

// ── SafetyGuard ──────────────────────────────────────────────────────────────

describe("SafetyGuard", () => {
  describe("protected paths", () => {
    it("blocks intents targeting protected paths", () => {
      const guard = new SafetyGuard({
        protectedPaths: ["src/config/", "src/twin-system/"],
      })
      const intent = createIntent({ targetFiles: ["src/config/loader.ts"] })
      const result = guard.check(intent)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain("Protected path")
    })

    it("allows intents targeting non-protected paths", () => {
      const guard = new SafetyGuard({
        protectedPaths: ["src/config/"],
      })
      const intent = createIntent({ targetFiles: ["src/server/routes.ts"] })
      const result = guard.check(intent)
      expect(result.allowed).toBe(true)
    })
  })

  describe("frequency limiting", () => {
    it("blocks when frequency limit exceeded", () => {
      const store = { getEvolutionCount: vi.fn(() => 5) }
      const guard = new SafetyGuard({ maxEvolutionsPerFile24h: 3 }, store)
      const intent = createIntent()
      const result = guard.check(intent)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain("Frequency limit")
    })

    it("allows when under frequency limit", () => {
      const store = { getEvolutionCount: vi.fn(() => 1) }
      const guard = new SafetyGuard({ maxEvolutionsPerFile24h: 3 }, store)
      const intent = createIntent()
      const result = guard.check(intent)
      expect(result.allowed).toBe(true)
    })
  })

  describe("circuit breaker", () => {
    it("blocks all intents when open", () => {
      const guard = new SafetyGuard()
      guard.openCircuit("Too many failures")
      const intent = createIntent()
      const result = guard.check(intent)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain("Circuit breaker open")
    })

    it("allows after circuit is closed", () => {
      const guard = new SafetyGuard()
      guard.openCircuit("Failures")
      guard.closeCircuit()
      const result = guard.check(createIntent())
      expect(result.allowed).toBe(true)
    })

    it("reports circuit state", () => {
      const guard = new SafetyGuard()
      expect(guard.isCircuitOpen()).toBe(false)
      guard.openCircuit("test reason")
      expect(guard.isCircuitOpen()).toBe(true)
      const state = guard.getCircuitState()
      expect(state.open).toBe(true)
      expect(state.reason).toBe("test reason")
      expect(state.openedAt).toBeTypeOf("number")
    })
  })

  describe("risk level gating", () => {
    it("requires approval for high-risk intents", () => {
      const guard = new SafetyGuard()
      const intent = createIntent({ riskLevel: "high" })
      const result = guard.check(intent)
      expect(result.allowed).toBe(true)
      expect(result.requiresApproval).toBe(true)
    })

    it("requires approval when intent has requiresHumanApproval=true", () => {
      const guard = new SafetyGuard()
      const intent = createIntent({ requiresHumanApproval: true })
      const result = guard.check(intent)
      expect(result.allowed).toBe(true)
      expect(result.requiresApproval).toBe(true)
    })

    it("does not require approval for low-risk intents", () => {
      const guard = new SafetyGuard()
      const intent = createIntent({ riskLevel: "low" })
      const result = guard.check(intent)
      expect(result.allowed).toBe(true)
      expect(result.requiresApproval).toBeUndefined()
    })
  })

  describe("getApprovalRequirement", () => {
    it("returns manual for high risk", () => {
      const guard = new SafetyGuard()
      expect(guard.getApprovalRequirement(createIntent({ riskLevel: "high" }))).toBe("manual")
    })

    it("returns review for medium risk", () => {
      const guard = new SafetyGuard()
      expect(guard.getApprovalRequirement(createIntent({ riskLevel: "medium" }))).toBe("review")
    })

    it("returns none for low risk", () => {
      const guard = new SafetyGuard()
      expect(guard.getApprovalRequirement(createIntent({ riskLevel: "low" }))).toBe("none")
    })
  })

  describe("isProtected", () => {
    it("matches exact paths", () => {
      const guard = new SafetyGuard({ protectedPaths: ["src/config/"] })
      expect(guard.isProtected("src/config/")).toBe(true)
    })

    it("matches prefix paths", () => {
      const guard = new SafetyGuard({ protectedPaths: ["src/config/"] })
      expect(guard.isProtected("src/config/loader.ts")).toBe(true)
    })

    it("does not match unrelated paths", () => {
      const guard = new SafetyGuard({ protectedPaths: ["src/config/"] })
      expect(guard.isProtected("src/server/routes.ts")).toBe(false)
    })
  })
})

// ── EvolutionPipeline ────────────────────────────────────────────────────────

describe("EvolutionPipeline", () => {
  let git: GitOps
  let slotManager: SlotManager
  let safetyGuard: SafetyGuard
  let mutator: Mutator
  let validator: Validator
  let pipeline: EvolutionPipeline

  beforeEach(() => {
    git = createMockGitOps()
    slotManager = new SlotManager(git)
    safetyGuard = new SafetyGuard({
      protectedPaths: ["src/config/"],
    })
    mutator = createMockMutator()
    validator = createMockValidator()
    pipeline = new EvolutionPipeline({
      slotManager,
      safetyGuard,
      mutator,
      validator,
      config: { autoSwitch: true, confidenceThreshold: 0.7 },
    })
  })

  describe("successful flow", () => {
    it("runs the complete pipeline and switches", async () => {
      const intent = createIntent()
      const result = await pipeline.run(intent)

      expect(result.success).toBe(true)
      expect(result.intentId).toBe(intent.id)
      expect(result.mutationResult?.success).toBe(true)
      expect(result.validationResult?.passed).toBe(true)
      expect(result.switchRecord).toBeDefined()
      expect(result.switchRecord?.action).toBe("switch")
    })

    it("emits correct events sequence", async () => {
      const intent = createIntent()
      const result = await pipeline.run(intent)

      const types = result.events.map((e) => e.type)
      expect(types).toContain("pipeline_started")
      expect(types).toContain("mutation_started")
      expect(types).toContain("mutation_completed")
      expect(types).toContain("validation_started")
      expect(types).toContain("validation_completed")
      expect(types).toContain("switch_requested")
      expect(types).toContain("switch_completed")
      expect(types).toContain("pipeline_completed")
    })

    it("calls mutator and validator in order", async () => {
      const intent = createIntent()
      await pipeline.run(intent)

      expect(mutator.mutate).toHaveBeenCalledWith(intent)
      expect(validator.validate).toHaveBeenCalledWith(intent)
    })
  })

  describe("safety check failures", () => {
    it("aborts when safety check fails (protected path)", async () => {
      const intent = createIntent({ targetFiles: ["src/config/secrets.ts"] })
      const result = await pipeline.run(intent)

      expect(result.success).toBe(false)
      expect(result.abortReason).toContain("Safety check failed")
      expect(mutator.mutate).not.toHaveBeenCalled()
    })

    it("aborts when circuit breaker is open", async () => {
      safetyGuard.openCircuit("Too many failures")
      const intent = createIntent()
      const result = await pipeline.run(intent)

      expect(result.success).toBe(false)
      expect(result.abortReason).toContain("Circuit breaker")
    })
  })

  describe("slot availability", () => {
    it("aborts when standby is not available", async () => {
      // Occupy the standby slot
      slotManager.beginEvolution(createIntent({ id: "occupier" }))

      const intent = createIntent({ id: "new-intent" })
      // Need a new pipeline because the safetyGuard won't block this intent
      const pipe = new EvolutionPipeline({
        slotManager: new SlotManager(git),
        safetyGuard,
        mutator,
        validator,
        config: { autoSwitch: true },
      })
      // Occupy the new slotManager's standby
      ;(pipe as any).slotManager.beginEvolution(createIntent({ id: "blocker" }))

      const result = await pipe.run(intent)
      expect(result.success).toBe(false)
      expect(result.abortReason).toContain("Standby slot not available")
    })
  })

  describe("mutation failures", () => {
    it("aborts when mutation fails", async () => {
      const failMutator = createMockMutator({
        success: false,
        error: "Could not produce valid code",
      })
      const pipe = new EvolutionPipeline({
        slotManager,
        safetyGuard,
        mutator: failMutator,
        validator,
        config: { autoSwitch: true },
      })

      const result = await pipe.run(createIntent())
      expect(result.success).toBe(false)
      expect(result.abortReason).toContain("Mutation failed")
      expect(slotManager.getStandby().status).toBe("standby")
    })

    it("aborts when mutation throws", async () => {
      const throwMutator: Mutator = {
        mutate: vi.fn(async () => { throw new Error("LLM timeout") }),
      }
      const pipe = new EvolutionPipeline({
        slotManager,
        safetyGuard,
        mutator: throwMutator,
        validator,
        config: { autoSwitch: true },
      })

      const result = await pipe.run(createIntent())
      expect(result.success).toBe(false)
      expect(result.abortReason).toContain("Mutation threw")
      expect(slotManager.getStandby().status).toBe("standby")
    })
  })

  describe("validation failures", () => {
    it("aborts when validation fails", async () => {
      const failValidator = createMockValidator({ passed: false, reason: "Tests failed" })
      const pipe = new EvolutionPipeline({
        slotManager,
        safetyGuard,
        mutator,
        validator: failValidator,
        config: { autoSwitch: true },
      })

      const result = await pipe.run(createIntent())
      expect(result.success).toBe(false)
      expect(result.abortReason).toContain("Validation failed")
      expect(slotManager.getStandby().status).toBe("standby")
    })

    it("aborts when validator throws", async () => {
      const throwValidator: Validator = {
        validate: vi.fn(async () => { throw new Error("OOM") }),
      }
      const pipe = new EvolutionPipeline({
        slotManager,
        safetyGuard,
        mutator,
        validator: throwValidator,
        config: { autoSwitch: true },
      })

      const result = await pipe.run(createIntent())
      expect(result.success).toBe(false)
      expect(result.abortReason).toContain("Validation threw")
    })
  })

  describe("approval gates", () => {
    it("requests approval for high-risk intents and proceeds when approved", async () => {
      const onApproval = vi.fn(async () => true)
      const pipe = new EvolutionPipeline({
        slotManager,
        safetyGuard,
        mutator,
        validator,
        config: { autoSwitch: true },
        onApprovalNeeded: onApproval,
      })

      const intent = createIntent({ riskLevel: "high" })
      const result = await pipe.run(intent)

      // First call: safety requires approval for high-risk
      expect(onApproval).toHaveBeenCalled()
      expect(result.success).toBe(true)
    })

    it("aborts when approval is denied at safety check", async () => {
      const onApproval = vi.fn(async () => false)
      const pipe = new EvolutionPipeline({
        slotManager,
        safetyGuard,
        mutator,
        validator,
        config: { autoSwitch: true },
        onApprovalNeeded: onApproval,
      })

      const intent = createIntent({ riskLevel: "high" })
      const result = await pipe.run(intent)

      expect(result.success).toBe(false)
      expect(result.abortReason).toContain("approval denied")
    })

    it("requests switch approval when confidence is below threshold", async () => {
      const lowConfMutator = createMockMutator({
        confidence: { score: 0.5, reason: "Uncertain", uncertainties: ["edge case"] },
      })
      const onApproval = vi.fn(async () => true)
      const pipe = new EvolutionPipeline({
        slotManager,
        safetyGuard,
        mutator: lowConfMutator,
        validator,
        config: { autoSwitch: true, confidenceThreshold: 0.7 },
        onApprovalNeeded: onApproval,
      })

      const intent = createIntent()
      const result = await pipe.run(intent)

      // Should request approval at switch step (2nd call — 1st is safety for low risk which doesn't require approval)
      expect(onApproval).toHaveBeenCalled()
      expect(result.success).toBe(true)
    })

    it("aborts switch when approval denied (low confidence)", async () => {
      const lowConfMutator = createMockMutator({
        confidence: { score: 0.5, reason: "Uncertain", uncertainties: ["edge case"] },
      })
      const onApproval = vi.fn(async () => false)
      const pipe = new EvolutionPipeline({
        slotManager,
        safetyGuard,
        mutator: lowConfMutator,
        validator,
        config: { autoSwitch: true, confidenceThreshold: 0.7 },
        onApprovalNeeded: onApproval,
      })

      const intent = createIntent()
      const result = await pipe.run(intent)

      expect(result.success).toBe(false)
      expect(result.abortReason).toContain("Switch approval denied")
    })

    it("requires approval when autoSwitch is false", async () => {
      const onApproval = vi.fn(async () => true)
      const pipe = new EvolutionPipeline({
        slotManager,
        safetyGuard,
        mutator,
        validator,
        config: { autoSwitch: false },
        onApprovalNeeded: onApproval,
      })

      const intent = createIntent()
      const result = await pipe.run(intent)

      expect(onApproval).toHaveBeenCalled()
      expect(result.success).toBe(true)
    })
  })

  describe("getEvents", () => {
    it("returns empty before any run", () => {
      expect(pipeline.getEvents()).toEqual([])
    })

    it("returns events after a run", async () => {
      await pipeline.run(createIntent())
      expect(pipeline.getEvents().length).toBeGreaterThan(0)
    })
  })
})
