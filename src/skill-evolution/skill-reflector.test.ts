/**
 * Tests for SkillReflector — the LLM-driven create/refine/skip decision.
 */
import { describe, it, expect } from "vitest"
import { SkillReflector } from "./skill-reflector.js"
import type { LlmClient, LlmMessage } from "./types.js"

function fakeLlm(response: string): LlmClient {
  return { chat: async (_: LlmMessage[]) => response }
}

const baseInput = {
  title: "Fix SSH remote build",
  problems: ["2 assistant messages contained error markers"],
  transcript: "[user] build fails\n[assistant] error: missing .js extension",
  existingSkills: [],
}

describe("SkillReflector", () => {
  it("parses a create decision", async () => {
    const llm = fakeLlm(
      JSON.stringify({
        action: "create",
        skillName: "esm-js-extensions",
        description: "Use when ESM imports fail at runtime",
        body: "# ESM\nAlways add .js to relative imports.",
        tags: ["esm", "typescript"],
        rationale: "Reusable ESM gotcha.",
      }),
    )
    const result = await new SkillReflector(llm).reflect(baseInput)
    expect(result.action).toBe("create")
    expect(result.skillName).toBe("esm-js-extensions")
    expect(result.body).toContain("Always add .js")
    expect(result.tags).toEqual(["esm", "typescript"])
  })

  it("parses a refine decision", async () => {
    const llm = fakeLlm(
      `\`\`\`json\n${JSON.stringify({
        action: "refine",
        skillName: "esm-js-extensions",
        description: "updated",
        body: "improved body",
        rationale: "sharpen",
      })}\n\`\`\``,
    )
    const result = await new SkillReflector(llm).reflect(baseInput)
    expect(result.action).toBe("refine")
    expect(result.body).toBe("improved body")
  })

  it("strips code fences and surrounding prose", async () => {
    const llm = fakeLlm(
      `Sure! Here is the decision:\n\`\`\`json\n${JSON.stringify({
        action: "skip",
        rationale: "too specific",
      })}\n\`\`\`\nHope that helps.`,
    )
    const result = await new SkillReflector(llm).reflect(baseInput)
    expect(result.action).toBe("skip")
    expect(result.rationale).toBe("too specific")
  })

  it("downgrades create-without-body to skip", async () => {
    const llm = fakeLlm(
      JSON.stringify({ action: "create", skillName: "x", rationale: "no body" }),
    )
    const result = await new SkillReflector(llm).reflect(baseInput)
    expect(result.action).toBe("skip")
  })

  it("returns skip on unparseable output", async () => {
    const result = await new SkillReflector(fakeLlm("not json at all")).reflect(baseInput)
    expect(result.action).toBe("skip")
  })

  it("returns skip on empty output", async () => {
    const result = await new SkillReflector(fakeLlm("")).reflect(baseInput)
    expect(result.action).toBe("skip")
  })

  it("salvages a create whose body has raw (unescaped) newlines", async () => {
    // The LLM emitted a long Markdown body with REAL line breaks inside the
    // JSON string — invalid JSON, but we must recover it instead of skipping.
    const broken = [
      "{",
      '  "action": "create",',
      '  "skillName": "ssh-remote-build",',
      '  "description": "Use when building on a remote SSH host",',
      '  "body": "## Remote Build',
      "### Steps",
      "1. scp files to remote",
      "2. run pnpm build on remote",
      '### Gotcha: ESM needs .js extensions",',
      '  "tags": ["ssh", "build"],',
      '  "rationale": "Reusable remote-build playbook."',
      "}",
    ].join("\n")
    const result = await new SkillReflector(fakeLlm(broken)).reflect(baseInput)
    expect(result.action).toBe("create")
    expect(result.skillName).toBe("ssh-remote-build")
    expect(result.body).toContain("## Remote Build")
    expect(result.body).toContain("ESM needs .js extensions")
    expect(result.tags).toEqual(["ssh", "build"])
  })

  it("recovers from trailing commas", async () => {
    const withTrailingComma = `{
      "action": "skip",
      "rationale": "nothing reusable",
    }`
    const result = await new SkillReflector(fakeLlm(withTrailingComma)).reflect(baseInput)
    expect(result.action).toBe("skip")
    expect(result.rationale).toBe("nothing reusable")
  })

  it("includes existing skills in the prompt", async () => {
    let captured: LlmMessage[] = []
    const llm: LlmClient = {
      chat: async (msgs) => {
        captured = msgs
        return JSON.stringify({ action: "skip", rationale: "covered" })
      },
    }
    await new SkillReflector(llm).reflect({
      ...baseInput,
      existingSkills: [
        {
          meta: {
            name: "existing-skill",
            description: "an existing one",
            version: 2,
            created_at: "",
            updated_at: "",
            usage_count: 3,
            source: "manual",
          },
        },
      ],
    })
    const userMsg = captured.find((m) => m.role === "user")!
    expect(userMsg.content).toContain("existing-skill")
    expect(userMsg.content).toContain("used 3x")
  })
})
