/**
 * Evolution orchestrator — wires up and uniformly drives GeminiClaw's TWO
 * independent self-evolution engines.
 *
 *   - CODE  engine: twin-system (mutates source code). Default OFF.
 *   - SKILL engine: Hermes-style (crystallises/refines SKILL.md). Default OFF.
 *
 * The two engines are fully independent: each has its own scheduler, its own
 * enabled flag, and its own evidence pipeline. They can run both at once, just
 * one, or none. This module is the single seam index.ts talks to so the rest of
 * the app never needs to know which engines exist.
 *
 * Backward compatibility: if `evolution.code.enabled` is omitted, the legacy
 * top-level `evolution.enabled` is used as the code engine's switch.
 */

import { homedir } from "node:os"
import { join } from "node:path"

import type { ProviderRouter } from "../providers/router.js"
import type { Message } from "../providers/types.js"
import type { Db } from "../db/client.js"
import type { Config } from "../config/schema.js"

import {
  createTwinSystem,
  type TwinSystemInstance,
} from "../twin-system/factory.js"

import type {
  EvolutionEngine,
  EvolutionEngineStatus,
  EvolutionCycleResult,
  EvolutionTrigger,
} from "./engine.js"

import {
  SkillEvolutionEngine,
  ConversationCandidateSource,
  type LlmClient,
  type LlmMessage,
  type SkillEngineLogger,
} from "../skill-evolution/index.js"

// ── Logger ───────────────────────────────────────────────────────────────────

const orchestratorLogger: SkillEngineLogger = {
  info: (msg, ...args) => console.log(`[evolution] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[evolution] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[evolution] ${msg}`, ...args),
}

// ── ProviderRouter → LlmClient adapter ───────────────────────────────────────

/** Adapts the multi-provider router to the minimal LlmClient the skill engine needs. */
class RouterLlmClient implements LlmClient {
  constructor(private readonly router: ProviderRouter) {}

  async chat(messages: LlmMessage[]): Promise<string> {
    const mapped: Message[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }))
    const res = await this.router.chat(mapped, { temperature: 0.2 })
    return res.content
  }
}

// ── Code engine: wraps the twin-system instance as an EvolutionEngine ─────────

class CodeEvolutionEngine implements EvolutionEngine {
  readonly kind = "code" as const
  readonly enabled: boolean

  private running = false

  constructor(
    private readonly twin: TwinSystemInstance,
    enabled: boolean,
  ) {
    this.enabled = enabled
  }

  start(): void {
    if (!this.enabled) {
      orchestratorLogger.info("Code engine disabled (evolution.code.enabled=false)")
      return
    }
    this.twin.start()
    this.running = true
    orchestratorLogger.info("Code engine started (twin-system)")
  }

  stop(): void {
    if (this.running) {
      this.twin.stop()
      this.running = false
    }
  }

  async runOnce(trigger: EvolutionTrigger = "manual"): Promise<EvolutionCycleResult> {
    const startedAt = Date.now()
    // The twin-system owns its cycle inside the scheduler's onTrigger; expose a
    // manual trigger via the scheduler so verification works while stopped.
    const success = await this.twin.scheduler.triggerManual()
    return {
      kind: this.kind,
      success,
      summary: success
        ? "Code evolution cycle completed and landed a change."
        : "Code evolution cycle ran but produced no landed change.",
      durationMs: Date.now() - startedAt,
      details: { trigger },
    }
  }

  status(): EvolutionEngineStatus {
    const m = this.twin.metrics.snapshot()
    return {
      kind: this.kind,
      enabled: this.enabled,
      running: this.running,
      totalCycles: m.totalCycles,
      successCount: m.successCount,
      failureCount: m.failureCount,
      extra: {
        dryRun: this.twin.dryRun,
        metrics: m,
      },
    }
  }

  /** Expose the underlying twin instance (for existing evolution routes). */
  getTwin(): TwinSystemInstance {
    return this.twin
  }

  /** Record activity into the code engine's scheduler tracker. */
  recordActivity(): void {
    this.twin.activityTracker.recordActivity()
  }
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export interface EvolutionSystem {
  readonly code: CodeEvolutionEngine
  readonly skill: SkillEvolutionEngine
  /** All engines, for uniform iteration. */
  readonly engines: EvolutionEngine[]
  /**
   * Shared LLM client used by the skill engine + candidate source. Exposed so
   * ad-hoc paths (e.g. the manual /scan route) can build a candidate source
   * that ALSO performs long-session task decomposition instead of falling back
   * to whole-session compression.
   */
  readonly skillLlm: LlmClient
  /** Underlying twin-system instance (existing routes depend on it). */
  readonly twin: TwinSystemInstance
  /** Record an HTTP request so both engines' idle timers reset. */
  recordActivity(): void
  /** Start enabled engines (call after the server is listening). */
  start(): void
  /** Stop all engines. */
  stop(): void
  /** Uniform status snapshot for both engines. */
  status(): { code: EvolutionEngineStatus; skill: EvolutionEngineStatus }
}

export function createEvolutionSystem(
  config: Config,
  router: ProviderRouter,
  db: Db,
  serverPort: number,
): EvolutionSystem {
  const evo = config.evolution

  // ── Code engine (twin-system) ──────────────────────────────────────────────
  // Backward compat: explicit evolution.code.enabled wins, else legacy enabled.
  const codeEnabled = evo.code?.enabled ?? evo.enabled
  const twin = createTwinSystem(evo, router, db, serverPort)
  const code = new CodeEvolutionEngine(twin, codeEnabled)

  // ── Skill engine (Hermes-style) ────────────────────────────────────────────
  const skillCfg = evo.skill
  const skillsRoot = skillCfg.skillsRoot ?? join(homedir(), ".geminiclaw", "skills")

  // One shared LLM client: the candidate source uses it to summarise long
  // conversation middles; the engine/reflector use it to judge + draft skills.
  const skillLlm = new RouterLlmClient(router)

  const candidateSource = new ConversationCandidateSource(
    db,
    {
      lookbackMs: skillCfg.lookbackMs,
      maxCandidates: skillCfg.maxCandidates,
    },
    {},
    skillLlm,
  )

  const skill = new SkillEvolutionEngine({
    config: {
      enabled: skillCfg.enabled,
      skillsRoot,
      idleThresholdMs: skillCfg.idleThresholdMs,
      cronIntervalMs: skillCfg.cronIntervalMs,
      dailyAtHour: skillCfg.dailyAtHour,
      cooldownMs: skillCfg.cooldownMs,
      maxActionsPerCycle: skillCfg.maxActionsPerCycle,
    },
    llm: skillLlm,
    candidateSource,
    activityTracker: { getIdleMs: () => twin.activityTracker.getIdleMs() },
    logger: orchestratorLogger,
  })

  const engines: EvolutionEngine[] = [code, skill]

  return {
    code,
    skill,
    engines,
    skillLlm,
    twin,
    recordActivity() {
      code.recordActivity()
    },
    start() {
      orchestratorLogger.info(
        "Evolution system: code=%s, skill=%s",
        codeEnabled ? "ON" : "off",
        skillCfg.enabled ? "ON" : "off",
      )
      code.start()
      skill.start()
    },
    stop() {
      code.stop()
      skill.stop()
    },
    status() {
      return { code: code.status(), skill: skill.status() }
    },
  }
}
