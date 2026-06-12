/**
 * Tests for SkillEvolutionEngine — the OBSERVE→REFLECT→CRYSTALLISE cycle.
 *
 * Uses a real SkillStore (tmp dir) + a real SkillReflector driven by a
 * scripted fake LLM, plus an in-memory CandidateSource.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { SkillEvolutionEngine, DEFAULT_SKILL_EVOLUTION_CONFIG } from "./skill-evolution-engine.js"
import { SkillStore } from "./skill-store.js"
import { SkillReflector } from "./skill-reflector.js"
import type { CandidateSource, LlmClient, ReflectionCandidate, SkillEngineLogger } from "./types.js"

const silentLogger: SkillEngineLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const idleTracker = { getIdleMs: () => 10 * 60 * 1000 }

/** A fake LLM that returns scripted responses in order. */
function scriptedLlm(responses: string[]): LlmClient {
  let i = 0
  return {
    chat: async () => responses[Math.min(i++, responses.length - 1)],
  }
}

function staticSource(candidates: ReflectionCandidate[]): CandidateSource {
  return { collect: () => candidates }
}

const candidate: ReflectionCandidate = {
  sessionId: "s1",
  title: "Fix ESM imports",
  problems: ["error markers"],
  transcript: "[assistant] error: missing .js",
  score: 3,
}

function makeEngine(opts: {
  root: string
  llm: LlmClient
  source: CandidateSource
  enabled?: boolean
  maxActionsPerCycle?: number
}): SkillEvolutionEngine {
  const store = new SkillStore({ root: opts.root })
  return new SkillEvolutionEngine({
    config: {
      ...DEFAULT_SKILL_EVOLUTION_CONFIG,
      enabled: opts.enabled ?? false,
      skillsRoot: opts.root,
      maxActionsPerCycle: opts.maxActionsPerCycle ?? 2,
    },
    llm: opts.llm,
    candidateSource: opts.source,
    activityTracker: idleTracker,
    logger: silentLogger,
    store,
    reflector: new SkillReflector(opts.llm),
  })
}

describe("SkillEvolutionEngine", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillengine-"))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("kind is 'skill'", () => {
    const engine = makeEngine({ root, llm: scriptedLlm(["{}"]), source: staticSource([]) })
    expect(engine.kind).toBe("skill")
  })

  it("creates a skill from a reflection", async () => {
    const llm = scriptedLlm([
      JSON.stringify({
        action: "create",
        skillName: "esm-js-extensions",
        description: "Use when ESM imports fail",
        body: "# ESM\nAdd .js extensions.",
        rationale: "reusable",
      }),
    ])
    const engine = makeEngine({ root, llm, source: staticSource([candidate]) })

    const result = await engine.runOnce("manual")
    expect(result.success).toBe(true)
    expect(result.kind).toBe("skill")

    const store = engine.getStore()
    expect(store.has("esm-js-extensions")).toBe(true)
    expect(engine.status().extra?.skillsCreated).toBe(1)
  })

  it("refines an existing skill", async () => {
    const llm = scriptedLlm([
      JSON.stringify({
        action: "refine",
        skillName: "esm-js-extensions",
        description: "updated desc",
        body: "improved body",
        rationale: "sharpen",
      }),
    ])
    const engine = makeEngine({ root, llm, source: staticSource([candidate]) })
    // Seed an existing skill.
    engine.getStore().create({
      name: "esm-js-extensions",
      description: "old",
      body: "old body",
    })

    const result = await engine.runOnce("manual")
    expect(result.success).toBe(true)
    const skill = engine.getStore().get("esm-js-extensions")!
    expect(skill.meta.version).toBe(2)
    expect(skill.body).toBe("improved body")
    expect(engine.status().extra?.skillsRefined).toBe(1)
  })

  it("converts create-of-existing into a refine", async () => {
    const llm = scriptedLlm([
      JSON.stringify({
        action: "create",
        skillName: "dup-skill",
        description: "d",
        body: "new body via create",
        rationale: "x",
      }),
    ])
    const engine = makeEngine({ root, llm, source: staticSource([candidate]) })
    engine.getStore().create({ name: "dup-skill", description: "old", body: "old" })

    const result = await engine.runOnce("manual")
    expect(result.success).toBe(true)
    expect(engine.getStore().get("dup-skill")!.meta.version).toBe(2)
    expect(engine.status().extra?.skillsRefined).toBe(1)
  })

  it("reports no-candidates when source is empty", async () => {
    const engine = makeEngine({ root, llm: scriptedLlm(["{}"]), source: staticSource([]) })
    const result = await engine.runOnce("manual")
    expect(result.success).toBe(false)
    expect(result.reason).toBe("no-candidates")
  })

  it("reports no-action when reflector skips", async () => {
    const llm = scriptedLlm([JSON.stringify({ action: "skip", rationale: "nothing" })])
    const engine = makeEngine({ root, llm, source: staticSource([candidate]) })
    const result = await engine.runOnce("manual")
    expect(result.success).toBe(false)
    expect(result.reason).toBe("no-action")
  })

  it("respects maxActionsPerCycle", async () => {
    const create = (n: string) =>
      JSON.stringify({
        action: "create",
        skillName: n,
        description: "d",
        body: "b",
        rationale: "r",
      })
    const llm = scriptedLlm([create("skill-a"), create("skill-b"), create("skill-c")])
    const source = staticSource([
      { ...candidate, sessionId: "a", title: "A" },
      { ...candidate, sessionId: "b", title: "B" },
      { ...candidate, sessionId: "c", title: "C" },
    ])
    const engine = makeEngine({ root, llm, source, maxActionsPerCycle: 2 })

    await engine.runOnce("manual")
    // Only 2 of the 3 candidates should have been processed.
    expect(engine.getStore().listNames().length).toBe(2)
  })

  it("status reflects enabled flag and counters", async () => {
    const engine = makeEngine({ root, llm: scriptedLlm(["{}"]), source: staticSource([]), enabled: false })
    const status = engine.status()
    expect(status.enabled).toBe(false)
    expect(status.running).toBe(false)
    expect(status.kind).toBe("skill")
  })

  it("start() is a no-op when disabled", () => {
    const engine = makeEngine({ root, llm: scriptedLlm(["{}"]), source: staticSource([]), enabled: false })
    engine.start()
    expect(engine.status().running).toBe(false)
    engine.stop()
  })

  it("runWithSource works regardless of enabled state", async () => {
    const llm = scriptedLlm([
      JSON.stringify({
        action: "create",
        skillName: "from-explicit-source",
        description: "d",
        body: "b",
        rationale: "r",
      }),
    ])
    const engine = makeEngine({ root, llm, source: staticSource([]), enabled: false })
    const result = await engine.runWithSource(staticSource([candidate]), "manual")
    expect(result.success).toBe(true)
    expect(engine.getStore().has("from-explicit-source")).toBe(true)
  })
})
