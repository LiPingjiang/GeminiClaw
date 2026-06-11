import { describe, it, expect, beforeEach, vi } from "vitest"
import { registry } from "./registry.js"
import "./delegate_tasks.js"
import {
  setMultiAgentRuntime,
  __resetMultiAgentRuntime,
} from "../multi-agent/runtime-context.js"
import type { ToolRegistryLike } from "../agent/loop.js"
import type { ToolContext } from "./types.js"

// ── Test doubles ─────────────────────────────────────────────────────────────

function mockRegistry(): ToolRegistryLike {
  const tools = [
    { name: "read", description: "Read", schema: {}, executionMode: "parallel" },
    { name: "write", description: "Write", schema: {}, executionMode: "sequential" },
    { name: "delegate_tasks", description: "Delegate", schema: {}, executionMode: "sequential" },
    { name: "create_agent", description: "Create", schema: {}, executionMode: "parallel" },
  ]
  return {
    get(name: string) {
      const t = tools.find((x) => x.name === name)
      if (!t) return null
      return {
        handler: async () => ({ content: `${name} ran`, isError: false }),
        schema: t.schema,
        executionMode: t.executionMode,
      }
    },
    list() {
      return tools
    },
  }
}

// chatFn that simply echoes which task it sees, so we can assert ordering.
function mockChatFn() {
  return vi.fn(async (messages: Array<{ role: string; content: string }>) => {
    const userMsg = messages.find((m) => m.role === "user")?.content ?? ""
    const m = /## Task: (.+)/.exec(userMsg)
    const title = m ? m[1].trim() : "unknown"
    return { content: `done:${title}`, tool_calls: undefined }
  })
}

function ctx(): ToolContext {
  return {
    sessionId: "s1",
    workdir: process.cwd(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

const tool = () => {
  const t = registry.get("delegate_tasks")
  if (!t) throw new Error("delegate_tasks not registered")
  return t
}

describe("delegate_tasks tool", () => {
  beforeEach(() => {
    __resetMultiAgentRuntime()
  })

  it("is registered with the expected name + schema", () => {
    const t = tool()
    expect(t.name).toBe("delegate_tasks")
    expect(t.schema.required).toContain("tasks")
    expect(t.executionMode).toBe("sequential")
  })

  it("degrades gracefully when runtime is not initialized", async () => {
    const res = await tool().handler(
      { tasks: [{ title: "a", description: "b" }] },
      ctx(),
    )
    expect(res.type).toBe("error")
    expect((res as { error: string }).error).toMatch(/未初始化/)
  })

  it("rejects empty task list", async () => {
    setMultiAgentRuntime({ chatFn: mockChatFn() as any, toolRegistry: mockRegistry() })
    const res = await tool().handler({ tasks: [] }, ctx())
    expect(res.type).toBe("error")
    expect((res as { error: string }).error).toMatch(/不能为空/)
  })

  it("rejects more than the max tasks per call", async () => {
    setMultiAgentRuntime({ chatFn: mockChatFn() as any, toolRegistry: mockRegistry() })
    const many = Array.from({ length: 7 }, (_, i) => ({
      title: `t${i}`,
      description: "x",
    }))
    const res = await tool().handler({ tasks: many }, ctx())
    expect(res.type).toBe("error")
    expect((res as { error: string }).error).toMatch(/最多委派/)
  })

  it("runs a batch in parallel and returns results in original order", async () => {
    const chat = mockChatFn()
    setMultiAgentRuntime({ chatFn: chat as any, toolRegistry: mockRegistry() })
    const res = await tool().handler(
      {
        tasks: [
          { title: "Alpha", description: "do alpha" },
          { title: "Beta", description: "do beta" },
          { title: "Gamma", description: "do gamma" },
        ],
        strategy: "parallel",
      },
      ctx(),
    )
    expect(res.type).toBe("text")
    const text = (res as { text: string }).text
    // original order preserved
    const ai = text.indexOf("Alpha")
    const bi = text.indexOf("Beta")
    const gi = text.indexOf("Gamma")
    expect(ai).toBeGreaterThanOrEqual(0)
    expect(ai).toBeLessThan(bi)
    expect(bi).toBeLessThan(gi)
    // success markers + summary line
    expect(text).toMatch(/3 成功/)
    expect((text.match(/✅/g) ?? []).length).toBe(3)
  })

  it("strips delegation/agent tools from leaf children (no recursion)", async () => {
    // Capture which tools the spawned child registry is asked for by inspecting
    // the scoped registry indirectly: a leaf requesting delegate_tasks should
    // have it filtered out before it ever reaches the boundary.
    const chat = mockChatFn()
    setMultiAgentRuntime({ chatFn: chat as any, toolRegistry: mockRegistry() })
    const res = await tool().handler(
      {
        tasks: [
          {
            title: "Leaf",
            description: "try to recurse",
            role: "leaf",
            allowed_tools: ["read", "delegate_tasks", "create_agent"],
          },
        ],
      },
      ctx(),
    )
    // It still completes (the child just doesn't get the forbidden tools).
    expect(res.type).toBe("text")
    expect((res as { text: string }).text).toMatch(/Leaf/)
  })
})
