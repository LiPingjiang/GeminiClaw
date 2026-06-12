/**
 * Tests for the /技能 (skill) slash command in evolution_command.
 *
 * Focuses on the user-initiated skill-evolution path:
 *   /技能          → list crystallised skills
 *   /技能 运行     → trigger one manual reflection cycle (runOnce("manual"))
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { registry } from "./registry.js"
// Importing for side effect: registers the "evolution_command" tool.
import "./evolution_command.js"

const ctx = {
  sessionId: "test-session",
  workdir: process.cwd(),
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
}

type TextResult = { type: string; text?: string; error?: string }

async function invoke(
  args: { command: string; args: string[] },
): Promise<TextResult> {
  const tool = registry.get("evolution_command")
  if (!tool) throw new Error("evolution_command not registered")
  return (await tool.handler(args, ctx)) as unknown as TextResult
}

describe("evolution_command — /技能 (skill engine)", () => {
  const g = globalThis as any

  beforeEach(() => {
    delete g.__evolutionSystem
  })

  afterEach(() => {
    delete g.__evolutionSystem
    vi.restoreAllMocks()
  })

  it("warns when the skill engine is not running", async () => {
    const res = await invoke({ command: "技能", args: [] })
    expect(res.type).toBe("text")
    expect(res.text).toContain("技能进化引擎未启动")
  })

  it("reports an empty skill library", async () => {
    g.__evolutionSystem = {
      skill: {
        getStore: () => ({ listAll: () => [] }),
        runOnce: vi.fn(),
      },
    }
    const res = await invoke({ command: "技能", args: [] })
    expect(res.type).toBe("text")
    expect(res.text).toContain("技能库为空")
  })

  it("lists crystallised skills", async () => {
    g.__evolutionSystem = {
      skill: {
        getStore: () => ({
          listAll: () => [
            { meta: { name: "proxy-troubleshooting", version: 2, description: "Diagnose proxy failures" } },
            { meta: { name: "git-rebase-flow", version: 1, description: "Safe interactive rebase" } },
          ],
        }),
        runOnce: vi.fn(),
      },
    }
    const res = await invoke({ command: "技能", args: [] })
    expect(res.type).toBe("text")
    expect(res.text).toContain("技能库（2 个）")
    expect(res.text).toContain("proxy-troubleshooting")
    expect(res.text).toContain("v2")
    expect(res.text).toContain("git-rebase-flow")
  })

  it("triggers a manual run via the 运行 subcommand and reports success", async () => {
    const runOnce = vi.fn().mockResolvedValue({
      success: true,
      summary: "Created skill 'foo'",
      details: { action: "create", skillName: "foo" },
      durationMs: 1234,
    })
    g.__evolutionSystem = { skill: { getStore: () => ({ listAll: () => [] }), runOnce } }

    const res = await invoke({ command: "技能", args: ["运行"] })
    expect(runOnce).toHaveBeenCalledWith("manual")
    expect(res.type).toBe("text")
    expect(res.text).toContain("技能进化完成")
    expect(res.text).toContain("Created skill 'foo'")
    expect(res.text).toContain("1234ms")
  })

  it("reports a no-op run", async () => {
    const runOnce = vi.fn().mockResolvedValue({
      success: false,
      summary: "No candidates met the threshold",
      reason: "minScore not reached",
      durationMs: 50,
    })
    g.__evolutionSystem = { skill: { getStore: () => ({ listAll: () => [] }), runOnce } }

    const res = await invoke({ command: "技能", args: ["run"] })
    expect(runOnce).toHaveBeenCalledWith("manual")
    expect(res.text).toContain("本次未产出新技能")
    expect(res.text).toContain("minScore not reached")
  })

  it("accepts the English alias /skill evolve", async () => {
    const runOnce = vi.fn().mockResolvedValue({
      success: true,
      summary: "Refined 'bar'",
      details: { action: "refine", skillName: "bar" },
      durationMs: 7,
    })
    g.__evolutionSystem = { skill: { getStore: () => ({ listAll: () => [] }), runOnce } }

    const res = await invoke({ command: "skill", args: ["evolve"] })
    expect(runOnce).toHaveBeenCalledWith("manual")
    expect(res.text).toContain("技能进化完成")
  })

  it("help text mentions the skill command", async () => {
    const res = await invoke({ command: "help", args: [] })
    expect(res.text).toContain("/技能")
    expect(res.text).toContain("/技能 运行")
  })
})
