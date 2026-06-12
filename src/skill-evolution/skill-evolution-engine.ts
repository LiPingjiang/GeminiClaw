/**
 * SkillEvolutionEngine — the Hermes-style skill-level self-evolution engine.
 *
 * Loop (one cycle):
 *   1. OBSERVE   — pull a batch of real conversations (CandidateSource).
 *   2. REFLECT   — for the top candidate, ask the reflector: create / refine / skip.
 *   3. CRYSTALLISE / SHARPEN — apply the decision to the SkillStore:
 *        - create : write a new SKILL.md under ~/.geminiclaw/skills/<name>/
 *        - refine : bump an existing skill's version with an improved body
 *        - skip   : do nothing (no reusable lesson)
 *   4. REUSE     — the agent loads these skills on future tasks (out of scope
 *                  here; this engine only produces/maintains them).
 *
 * Unlike the code engine, this engine:
 *   - never touches source code, git, or the build,
 *   - is low-risk (writing a Markdown file),
 *   - has its own scheduler and is toggled independently.
 */

import { SchedulerRunner } from "../twin-system/scheduler.js"
import type { ActivityTracker } from "../twin-system/scheduler.js"
import type {
  EvolutionEngine,
  EvolutionCycleResult,
  EvolutionEngineStatus,
  EvolutionTrigger,
} from "../evolution-core/engine.js"
import { SkillStore } from "./skill-store.js"
import { SkillReflector } from "./skill-reflector.js"
import type { CandidateSource, LlmClient, SkillEngineLogger } from "./types.js"

// ── Config ───────────────────────────────────────────────────────────────────

export interface SkillEvolutionConfig {
  enabled: boolean
  /** Root dir for skill files. Defaults to ~/.geminiclaw/skills. */
  skillsRoot?: string
  /** Scheduler: idle threshold (ms). */
  idleThresholdMs: number
  /** Scheduler: cron interval (ms). 0 disables cron. */
  cronIntervalMs: number
  /** Scheduler: cooldown between triggers (ms). */
  cooldownMs: number
  /** Max skills to create/refine per cycle. */
  maxActionsPerCycle: number
}

export const DEFAULT_SKILL_EVOLUTION_CONFIG: SkillEvolutionConfig = {
  enabled: false,
  idleThresholdMs: 5 * 60 * 1000,
  cronIntervalMs: 30 * 60 * 1000,
  cooldownMs: 10 * 60 * 1000,
  maxActionsPerCycle: 2,
}

// ── Engine ───────────────────────────────────────────────────────────────────

export interface SkillEvolutionEngineDeps {
  config: SkillEvolutionConfig
  llm: LlmClient
  /** Default (automatic) candidate source — usually a 24h conversation scan. */
  candidateSource: CandidateSource
  activityTracker: ActivityTracker
  logger: SkillEngineLogger
  /** Override store (mainly for tests). */
  store?: SkillStore
  /** Override reflector (mainly for tests). */
  reflector?: SkillReflector
}

export class SkillEvolutionEngine implements EvolutionEngine {
  readonly kind = "skill" as const
  readonly enabled: boolean

  private readonly config: SkillEvolutionConfig
  private readonly store: SkillStore
  private readonly reflector: SkillReflector
  private readonly defaultSource: CandidateSource
  private readonly logger: SkillEngineLogger
  private readonly scheduler: SchedulerRunner

  private cycleRunning = false
  private totalCycles = 0
  private successCount = 0
  private failureCount = 0
  private skillsCreated = 0
  private skillsRefined = 0
  private schedulerRunning = false

  constructor(deps: SkillEvolutionEngineDeps) {
    this.config = deps.config
    this.enabled = deps.config.enabled
    this.logger = deps.logger
    this.defaultSource = deps.candidateSource
    this.store = deps.store ?? new SkillStore({ root: deps.config.skillsRoot })
    this.reflector = deps.reflector ?? new SkillReflector(deps.llm)

    this.scheduler = new SchedulerRunner({
      activityTracker: deps.activityTracker,
      onTrigger: async (reason) => {
        const result = await this.runCycle(reason, this.defaultSource)
        return result.success
      },
      config: {
        idleThresholdMs: this.config.idleThresholdMs,
        cronIntervalMs: this.config.cronIntervalMs,
        cooldownMs: this.config.cooldownMs,
        idleEnabled: true,
        cronEnabled: this.config.cronIntervalMs > 0,
      },
      logger: {
        info: (m, ...a) => this.logger.info(`[skill] ${m}`, ...a),
        warn: (m, ...a) => this.logger.warn(`[skill] ${m}`, ...a),
      },
    })
  }

  // ── EvolutionEngine interface ──────────────────────────────────────────────

  start(): void {
    if (!this.enabled) {
      this.logger.info("Skill engine disabled (evolution.skill.enabled=false)")
      return
    }
    this.store.ensureRoot()
    this.scheduler.start()
    this.schedulerRunning = true
    this.logger.info(
      "Skill engine started (skillsRoot=%s, cron=%sms)",
      this.store.root,
      this.config.cronIntervalMs,
    )
  }

  stop(): void {
    if (this.schedulerRunning) {
      this.scheduler.stop()
      this.schedulerRunning = false
    }
  }

  /** Run one cycle on the default (24h auto) source. */
  async runOnce(trigger: EvolutionTrigger = "manual"): Promise<EvolutionCycleResult> {
    return this.runCycle(trigger, this.defaultSource)
  }

  /**
   * Run one cycle on an explicit source (used by the manual scan API to scan a
   * chosen batch of conversations). Works regardless of enabled state so the
   * verification API always functions.
   */
  async runWithSource(
    source: CandidateSource,
    trigger: EvolutionTrigger = "manual",
  ): Promise<EvolutionCycleResult> {
    return this.runCycle(trigger, source)
  }

  status(): EvolutionEngineStatus {
    return {
      kind: this.kind,
      enabled: this.enabled,
      running: this.schedulerRunning,
      totalCycles: this.totalCycles,
      successCount: this.successCount,
      failureCount: this.failureCount,
      extra: {
        skillsRoot: this.store.root,
        skillCount: this.store.listNames().length,
        skillsCreated: this.skillsCreated,
        skillsRefined: this.skillsRefined,
      },
    }
  }

  /** Read-only access to the underlying store (for the skills API). */
  getStore(): SkillStore {
    return this.store
  }

  // ── Core cycle ─────────────────────────────────────────────────────────────

  private async runCycle(
    trigger: EvolutionTrigger,
    source: CandidateSource,
  ): Promise<EvolutionCycleResult> {
    const startedAt = Date.now()

    if (this.cycleRunning) {
      return {
        kind: this.kind,
        success: false,
        reason: "busy",
        summary: "A skill-evolution cycle is already running; skipped.",
        durationMs: 0,
      }
    }
    this.cycleRunning = true

    try {
      this.store.ensureRoot()

      const candidates = await source.collect()
      if (candidates.length === 0) {
        return this.finish(startedAt, {
          success: false,
          reason: "no-candidates",
          summary: "No conversations matched the scan; nothing to reflect on.",
        })
      }

      const existing = this.store.listAll().map((s) => ({ meta: s.meta }))
      const actions: Array<{ action: string; skill: string }> = []
      const budget = Math.max(1, this.config.maxActionsPerCycle)

      for (const candidate of candidates.slice(0, budget)) {
        const reflection = await this.reflector.reflect({
          title: candidate.title,
          problems: candidate.problems,
          transcript: candidate.transcript,
          existingSkills: existing,
        })

        this.logger.info(
          "Reflection for '%s': action=%s (%s)",
          candidate.title,
          reflection.action,
          reflection.rationale,
        )

        if (reflection.action === "skip") continue

        try {
          if (reflection.action === "create") {
            // If the chosen name already exists, fall through to refine it.
            if (reflection.skillName && this.store.has(reflection.skillName)) {
              const updated = this.store.update(reflection.skillName, {
                description: reflection.description,
                body: reflection.body,
                tags: reflection.tags,
              })
              this.skillsRefined++
              actions.push({ action: "refine", skill: updated.meta.name })
            } else {
              const created = this.store.create({
                name: reflection.skillName!,
                description: reflection.description!,
                body: reflection.body!,
                source: "conversation-reflection",
                tags: reflection.tags,
              })
              this.skillsCreated++
              actions.push({ action: "create", skill: created.meta.name })
            }
          } else if (reflection.action === "refine") {
            if (reflection.skillName && this.store.has(reflection.skillName)) {
              const updated = this.store.update(reflection.skillName, {
                description: reflection.description,
                body: reflection.body,
                tags: reflection.tags,
              })
              this.skillsRefined++
              actions.push({ action: "refine", skill: updated.meta.name })
            } else if (reflection.skillName) {
              // Reflector wanted to refine something that doesn't exist → create it.
              const created = this.store.create({
                name: reflection.skillName,
                description: reflection.description!,
                body: reflection.body!,
                source: "conversation-reflection",
                tags: reflection.tags,
              })
              this.skillsCreated++
              actions.push({ action: "create", skill: created.meta.name })
            }
          }
        } catch (err) {
          this.logger.error(
            "Failed to apply reflection (%s): %s",
            reflection.action,
            err instanceof Error ? err.message : String(err),
          )
        }
      }

      if (actions.length === 0) {
        return this.finish(startedAt, {
          success: false,
          reason: "no-action",
          summary: `Reflected on ${candidates.length} conversation(s); none yielded a reusable skill.`,
          details: { candidates: candidates.length },
        })
      }

      return this.finish(startedAt, {
        success: true,
        summary: `Skill evolution: ${actions
          .map((a) => `${a.action} '${a.skill}'`)
          .join(", ")}.`,
        details: { actions, candidates: candidates.length, trigger },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error("Skill cycle threw: %s", msg)
      return this.finish(startedAt, {
        success: false,
        reason: "error",
        summary: `Skill cycle failed: ${msg}`,
      })
    } finally {
      this.cycleRunning = false
    }
  }

  private finish(
    startedAt: number,
    partial: Omit<EvolutionCycleResult, "kind" | "durationMs">,
  ): EvolutionCycleResult {
    this.totalCycles++
    if (partial.success) this.successCount++
    else this.failureCount++
    return {
      kind: this.kind,
      durationMs: Date.now() - startedAt,
      ...partial,
    }
  }
}
