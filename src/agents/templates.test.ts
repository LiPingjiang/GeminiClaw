import { describe, it, expect, beforeEach } from "vitest"
import {
  loadAgentTemplates,
  getTemplateByName,
  listTemplateNames,
  getAllTemplates,
  __resetTemplates,
} from "./templates.js"

describe("Agent Templates", () => {
  beforeEach(() => {
    __resetTemplates()
  })

  it("loads templates from config agents section", () => {
    const config = {
      agents: [
        {
          name: "translator",
          displayName: "翻译助手",
          systemPrompt: "你是一个专业翻译。",
          tools: ["web_search"],
          deniedTools: [],
          model: "claude-sonnet",
          maxTurns: 4,
          capabilities: "多语言翻译",
        },
        {
          name: "researcher",
          displayName: "调研助手",
          systemPrompt: "你是一个调研专家。",
          tools: [],
          deniedTools: [],
          maxTurns: 12,
          capabilities: "信息调研",
        },
      ],
    }
    const templates = loadAgentTemplates(config as any)
    expect(templates).toHaveLength(2)
    expect(templates[0].name).toBe("translator")
    expect(templates[0].displayName).toBe("翻译助手")
    expect(templates[0].model).toBe("claude-sonnet")
  })

  it("getTemplateByName returns matching template", () => {
    loadAgentTemplates({
      agents: [
        {
          name: "translator",
          displayName: "翻译助手",
          systemPrompt: "你是一个专业翻译。",
          tools: [],
          deniedTools: [],
          maxTurns: 8,
          capabilities: "",
        },
      ],
    })
    const t = getTemplateByName("translator")
    expect(t).not.toBeNull()
    expect(t!.displayName).toBe("翻译助手")
  })

  it("returns null for unknown template name", () => {
    loadAgentTemplates({ agents: [] })
    expect(getTemplateByName("nonexistent")).toBeNull()
  })

  it("listTemplateNames returns all names", () => {
    loadAgentTemplates({
      agents: [
        { name: "a", displayName: "A", systemPrompt: "", tools: [], deniedTools: [], maxTurns: 8, capabilities: "" },
        { name: "b", displayName: "B", systemPrompt: "", tools: [], deniedTools: [], maxTurns: 8, capabilities: "" },
      ],
    })
    expect(listTemplateNames()).toEqual(["a", "b"])
  })

  it("getAllTemplates returns copies", () => {
    loadAgentTemplates({
      agents: [
        { name: "x", displayName: "X", systemPrompt: "", tools: [], deniedTools: [], maxTurns: 8, capabilities: "" },
      ],
    })
    const all = getAllTemplates()
    expect(all).toHaveLength(1)
    expect(all[0].name).toBe("x")
  })

  it("handles missing fields with defaults", () => {
    loadAgentTemplates({
      agents: [
        { name: "minimal", displayName: "Min" } as any,
      ],
    })
    const t = getTemplateByName("minimal")
    expect(t).not.toBeNull()
    expect(t!.systemPrompt).toBe("")
    expect(t!.tools).toEqual([])
    expect(t!.maxTurns).toBe(12)
  })
})
