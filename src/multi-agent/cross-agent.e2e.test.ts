import { describe, it, expect, beforeEach, vi } from "vitest"
import { registry } from "../tools/registry.js"
import "../tools/delegate_to.js"
import {
  setMultiAgentRuntime,
  __resetMultiAgentRuntime,
} from "./runtime-context.js"
import { __resetMailbox, getMessage } from "./mailbox.js"
import { __resetSubagentRegistry, getRun } from "./subagent-registry.js"
import {
  initResultInjector,
  registerPushFn,
  registerContextInjector,
  __resetResultInjector,
} from "./result-injector.js"
import { __resetLifecycleBus } from "./lifecycle-bus.js"
import { loadAgentTemplates, __resetTemplates } from "../agents/templates.js"

describe("Cross-Agent Delegation E2E", () => {
  beforeEach(() => {
    __resetMultiAgentRuntime()
    __resetMailbox()
    __resetSubagentRegistry()
    __resetResultInjector()
    __resetLifecycleBus()
    __resetTemplates()

    loadAgentTemplates({
      agents: [
        {
          name: "translator",
          displayName: "翻译助手",
          systemPrompt: "你是翻译专家。请将用户提供的文本翻译成中文。",
          tools: [],
          deniedTools: [],
          maxTurns: 4,
          capabilities: "翻译",
        },
        {
          name: "summarizer",
          displayName: "摘要助手",
          systemPrompt: "你是摘要专家。请简洁地总结用户提供的内容。",
          tools: [],
          deniedTools: [],
          maxTurns: 4,
          capabilities: "文本摘要",
        },
      ],
    })
  })

  it("full flow: delegate → execute → result pushed to user + injected to session", async () => {
    // Mock chatFn that simulates the translator responding
    const chatFn = vi.fn().mockResolvedValue({
      content: "你好世界",
      tool_calls: undefined,
    })
    setMultiAgentRuntime({
      chatFn,
      toolRegistry: { get: () => null, list: () => [] },
    } as any)

    // Track injections
    const injected: Array<{ sessionId: string; content: string }> = []
    const pushed: Array<{ userId: string; content: string }> = []

    registerPushFn(async (userId, content) => {
      pushed.push({ userId, content })
    })
    registerContextInjector(async (sessionId, content) => {
      injected.push({ sessionId, content })
    })
    initResultInjector()

    // Agent A delegates to translator
    const tool = registry.get("delegate_to")!
    const res = await tool.handler(
      { target: "translator", task: "翻译 hello world" },
      {
        sessionId: "session-A",
        workdir: "/tmp",
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        extra: { userId: "user-1", targetAgentId: "agent-A" },
      },
    )

    expect(res.type).toBe("text")
    expect((res as any).text).toContain("已委派")

    // Wait for background execution
    await new Promise((r) => setTimeout(r, 300))

    // Verify chatFn was called with translator's system prompt
    expect(chatFn).toHaveBeenCalled()
    const callMessages = chatFn.mock.calls[0][0]
    expect(callMessages[0].role).toBe("system")
    expect(callMessages[0].content).toContain("翻译专家")
    expect(callMessages[1].role).toBe("user")
    expect(callMessages[1].content).toContain("hello world")

    // Verify result was pushed to user
    expect(pushed.length).toBeGreaterThan(0)
    expect(pushed[0].userId).toBe("user-1")
    expect(pushed[0].content).toContain("你好世界")

    // Verify result was injected into parent session
    expect(injected.length).toBeGreaterThan(0)
    expect(injected[0].sessionId).toBe("session-A")
    expect(injected[0].content).toContain("你好世界")
  })

  it("handles execution failure gracefully", async () => {
    const chatFn = vi.fn().mockRejectedValue(new Error("LLM timeout"))
    setMultiAgentRuntime({
      chatFn,
      toolRegistry: { get: () => null, list: () => [] },
    } as any)

    const pushed: Array<{ userId: string; content: string }> = []
    const injected: Array<{ sessionId: string; content: string }> = []

    registerPushFn(async (userId, content) => {
      pushed.push({ userId, content })
    })
    registerContextInjector(async (sessionId, content) => {
      injected.push({ sessionId, content })
    })
    initResultInjector()

    const tool = registry.get("delegate_to")!
    const res = await tool.handler(
      { target: "translator", task: "翻译 hello" },
      {
        sessionId: "session-B",
        workdir: "/tmp",
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        extra: { userId: "user-2", targetAgentId: "agent-B" },
      },
    )

    expect(res.type).toBe("text")
    expect((res as any).text).toContain("已委派")

    // Wait for background failure
    await new Promise((r) => setTimeout(r, 300))

    // Verify error was pushed to user
    expect(pushed.length).toBeGreaterThan(0)
    expect(pushed[0].content).toContain("失败")
    expect(pushed[0].content).toContain("LLM timeout")

    // Verify error was injected into session
    expect(injected.length).toBeGreaterThan(0)
    expect(injected[0].content).toContain("失败")
  })

  it("multiple delegations to different agents work concurrently", async () => {
    let callCount = 0
    const chatFn = vi.fn().mockImplementation(async (messages: any[]) => {
      callCount++
      // Simulate different response times
      await new Promise((r) => setTimeout(r, 50))
      const isTranslator = messages[0]?.content?.includes("翻译")
      return {
        content: isTranslator ? "你好世界" : "这是一段关于AI的摘要",
        tool_calls: undefined,
      }
    })
    setMultiAgentRuntime({
      chatFn,
      toolRegistry: { get: () => null, list: () => [] },
    } as any)

    const pushed: Array<{ userId: string; content: string }> = []
    registerPushFn(async (userId, content) => {
      pushed.push({ userId, content })
    })
    registerContextInjector(async () => {})
    initResultInjector()

    const tool = registry.get("delegate_to")!
    const ctx = {
      sessionId: "session-C",
      workdir: "/tmp",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      extra: { userId: "user-3", targetAgentId: "agent-C" },
    }

    // Delegate to both agents
    const res1 = await tool.handler(
      { target: "translator", task: "翻译 hello world" },
      ctx,
    )
    const res2 = await tool.handler(
      { target: "summarizer", task: "总结这篇文章" },
      ctx,
    )

    expect(res1.type).toBe("text")
    expect(res2.type).toBe("text")

    // Wait for both to complete
    await new Promise((r) => setTimeout(r, 400))

    // Both should have been called
    expect(chatFn).toHaveBeenCalledTimes(2)
    // Both results should have been pushed
    expect(pushed.length).toBe(2)
  })
})
