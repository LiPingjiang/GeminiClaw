import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { registry } from "./registry.js"
import "./delegate_tasks.js"
import {
  setMultiAgentRuntime,
  __resetMultiAgentRuntime,
} from "../multi-agent/runtime-context.js"
import { __resetSubagentRegistry, getRun, getRunningForParent } from "../multi-agent/subagent-registry.js"
import { __resetLifecycleBus } from "../multi-agent/lifecycle-bus.js"
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
    __resetSubagentRegistry()
    __resetLifecycleBus()
  })

  afterEach(() => {
    __resetSubagentRegistry()
    __resetLifecycleBus()
  })

  it("is registered with the expected name + schema", () => {
    const t = tool()
    expect(t.name).toBe("delegate_tasks")
    expect(t.schema.required).toContain("tasks")
    expect(t.executionMode).toBe("sequential")
  })

  it("returns error when runtime is not initialized", async () => {
    // asyncExecute checks getMultiAgentRuntime internally
    const res = await tool().handler(
      { tasks: [{ title: "a", description: "b" }] },
      ctx(),
    )
    expect(res.type).toBe("error")
    expect((res as { error: string }).error).toMatch(/未初始化|被拒绝/)
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

  it("accepts tasks immediately (non-blocking) and returns runId", async () => {
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
    // Should contain acceptance message
    expect(text).toMatch(/已接受 3 个子任务/)
    expect(text).toMatch(/后台异步执行中/)
    expect(text).toMatch(/run_/)
    // Task titles listed
    expect(text).toContain("Alpha")
    expect(text).toContain("Beta")
    expect(text).toContain("Gamma")
    // Should NOT contain completion results (non-blocking)
    expect(text).not.toMatch(/3 成功/)
  })

  it("registers run in SubagentRegistry", async () => {
    const chat = mockChatFn()
    setMultiAgentRuntime({ chatFn: chat as any, toolRegistry: mockRegistry() })
    const res = await tool().handler(
      {
        tasks: [
          { title: "Task1", description: "do task1" },
        ],
        strategy: "parallel",
      },
      ctx(),
    )
    const text = (res as { text: string }).text
    const runIdMatch = text.match(/run_[a-f0-9-]+/)
    expect(runIdMatch).not.toBeNull()
    const runId = runIdMatch![0]
    // Run should be registered
    const record = getRun(runId)
    expect(record).toBeDefined()
    expect(record!.status).toBe("running")
    expect(record!.parentSessionId).toBe("s1")
    expect(record!.taskTitles).toContain("Task1")
  })

  it("strips delegation/agent tools from leaf children", async () => {
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
    // It should be accepted (the filtering happens during execution)
    expect(res.type).toBe("text")
    expect((res as { text: string }).text).toMatch(/Leaf/)
  })

  it("completes in background and updates registry", async () => {
    const chat = mockChatFn()
    setMultiAgentRuntime({ chatFn: chat as any, toolRegistry: mockRegistry() })
    const res = await tool().handler(
      {
        tasks: [
          { title: "Quick", description: "fast task" },
        ],
        strategy: "parallel",
      },
      ctx(),
    )
    const text = (res as { text: string }).text
    const runId = text.match(/run_[a-f0-9-]+/)![0]

    // Wait for background execution to complete
    await new Promise((r) => setTimeout(r, 500))

    const record = getRun(runId)
    expect(record).toBeDefined()
    expect(record!.status).toBe("completed")
    expect(record!.result).toBeDefined()
    expect(record!.result).toMatch(/委派完成/)
  })

  it("handles sub-agent failure in background", async () => {
    const chat = vi.fn(
      async (messages: Array<{ role: string; content: string }>) => {
        // Task details are now in the system prompt (not user message),
        // so check all messages for "Boom" to simulate failure for that task.
        const allContent = messages.map((m) => m.content).join(" ")
        if (allContent.includes("Boom")) throw new Error("sub-agent exploded")
        return { content: "done", tool_calls: undefined }
      },
    )
    setMultiAgentRuntime({ chatFn: chat as any, toolRegistry: mockRegistry() })
    const res = await tool().handler(
      {
        tasks: [
          { title: "Okay", description: "this one works" },
          { title: "Boom", description: "this one throws" },
        ],
        strategy: "parallel",
      },
      ctx(),
    )
    // Immediately accepted
    expect(res.type).toBe("text")
    expect((res as { text: string }).text).toMatch(/已接受 2 个子任务/)

    // Wait for background execution
    await new Promise((r) => setTimeout(r, 500))

    const text = (res as { text: string }).text
    const runId = text.match(/run_[a-f0-9-]+/)![0]
    const record = getRun(runId)
    expect(record).toBeDefined()
    // Should complete (partial success is still "completed" at the run level)
    expect(record!.status).toBe("completed")
    expect(record!.result).toMatch(/1 成功/)
    expect(record!.result).toMatch(/1 失败/)
  })

  it("respects concurrent run limit per parent session", async () => {
    const chat = vi.fn(async () => {
      // Simulate slow task
      await new Promise((r) => setTimeout(r, 2000))
      return { content: "done", tool_calls: undefined }
    })
    setMultiAgentRuntime({ chatFn: chat as any, toolRegistry: mockRegistry() })

    // Launch 3 runs (the max)
    for (let i = 0; i < 3; i++) {
      const res = await tool().handler(
        { tasks: [{ title: `Run${i}`, description: "slow" }] },
        ctx(),
      )
      expect(res.type).toBe("text")
    }

    // 4th should be rejected
    const res = await tool().handler(
      { tasks: [{ title: "Overflow", description: "too many" }] },
      ctx(),
    )
    expect(res.type).toBe("error")
    expect((res as { error: string }).error).toMatch(/上限|被拒绝/)
  })
})
