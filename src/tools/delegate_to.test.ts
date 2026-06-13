import { describe, it, expect, beforeEach, vi } from "vitest"
import { registry } from "./registry.js"
import "./delegate_to.js"
import {
  setMultiAgentRuntime,
  __resetMultiAgentRuntime,
} from "../multi-agent/runtime-context.js"
import { __resetMailbox, getMessage } from "../multi-agent/mailbox.js"
import { __resetSubagentRegistry } from "../multi-agent/subagent-registry.js"
import { __resetLifecycleBus } from "../multi-agent/lifecycle-bus.js"
import { loadAgentTemplates, __resetTemplates } from "../agents/templates.js"

describe("delegate_to tool", () => {
  beforeEach(() => {
    __resetMultiAgentRuntime()
    __resetMailbox()
    __resetSubagentRegistry()
    __resetLifecycleBus()
    __resetTemplates()
    // Load test templates
    loadAgentTemplates({
      agents: [
        {
          name: "translator",
          displayName: "翻译助手",
          systemPrompt: "你是翻译专家。",
          tools: [],
          deniedTools: [],
          maxTurns: 8,
          capabilities: "翻译各种语言",
        },
        {
          name: "researcher",
          displayName: "调研助手",
          systemPrompt: "你是调研专家。",
          tools: ["web_search"],
          deniedTools: [],
          maxTurns: 12,
          capabilities: "信息调研",
        },
      ],
    })
  })

  const ctx = () => ({
    sessionId: "test-session",
    workdir: "/tmp",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    extra: { userId: "user-123", targetAgentId: "agent-A" },
  })

  it("is registered in the tool registry", () => {
    const tool = registry.get("delegate_to")
    expect(tool).not.toBeNull()
    expect(tool!.name).toBe("delegate_to")
  })

  it("rejects when runtime not wired", async () => {
    const tool = registry.get("delegate_to")!
    const res = await tool.handler(
      { target: "translator", task: "翻译 hello" },
      ctx(),
    )
    expect(res.type).toBe("error")
    expect((res as any).error).toContain("运行时未初始化")
  })

  it("rejects empty target", async () => {
    setMultiAgentRuntime({
      chatFn: vi.fn().mockResolvedValue({ content: "ok" }),
      toolRegistry: { get: () => null, list: () => [] },
    } as any)
    const tool = registry.get("delegate_to")!
    const res = await tool.handler({ target: "", task: "do something" }, ctx())
    expect(res.type).toBe("error")
    expect((res as any).error).toContain("不能为空")
  })

  it("rejects unknown target agent name", async () => {
    setMultiAgentRuntime({
      chatFn: vi.fn().mockResolvedValue({ content: "ok" }),
      toolRegistry: { get: () => null, list: () => [] },
    } as any)
    const tool = registry.get("delegate_to")!
    const res = await tool.handler(
      { target: "nonexistent", task: "do something" },
      ctx(),
    )
    expect(res.type).toBe("error")
    expect((res as any).error).toContain("未找到")
    expect((res as any).error).toContain("translator")
  })

  it("accepts valid delegation and returns immediately", async () => {
    const chatFn = vi.fn().mockResolvedValue({ content: "翻译完成：你好世界" })
    setMultiAgentRuntime({
      chatFn,
      toolRegistry: { get: () => null, list: () => [] },
    } as any)

    const tool = registry.get("delegate_to")!
    const res = await tool.handler(
      { target: "translator", task: "翻译 hello world", context: "用户需要中文翻译" },
      ctx(),
    )

    expect(res.type).toBe("text")
    expect((res as any).text).toContain("已委派")
    expect((res as any).text).toContain("翻译助手")
    expect((res as any).text).toContain("translator")
  })

  it("creates a mailbox message on delegation", async () => {
    const chatFn = vi.fn().mockResolvedValue({ content: "done" })
    setMultiAgentRuntime({
      chatFn,
      toolRegistry: { get: () => null, list: () => [] },
    } as any)

    const tool = registry.get("delegate_to")!
    const res = await tool.handler(
      { target: "translator", task: "翻译 hello" },
      ctx(),
    )

    // Extract message ID from response
    const text = (res as any).text as string
    const msgIdMatch = text.match(/消息ID: (msg_[\w-]+)/)
    expect(msgIdMatch).not.toBeNull()

    const msg = getMessage(msgIdMatch![1])
    expect(msg).toBeDefined()
    expect(msg!.to).toBe("translator")
    // Status may be "executing" or "completed" depending on timing
    // (mock chatFn resolves instantly, so background may finish before we check)
    expect(["executing", "completed"]).toContain(msg!.status)
  })

  it("executes in background and calls chatFn with target system prompt", async () => {
    const chatFn = vi.fn().mockResolvedValue({ content: "翻译结果" })
    setMultiAgentRuntime({
      chatFn,
      toolRegistry: { get: () => null, list: () => [] },
    } as any)

    const tool = registry.get("delegate_to")!
    await tool.handler(
      { target: "translator", task: "翻译 hello" },
      ctx(),
    )

    // Wait for background execution
    await new Promise((r) => setTimeout(r, 100))

    expect(chatFn).toHaveBeenCalled()
    const callMessages = chatFn.mock.calls[0][0]
    // First message should be the system prompt
    expect(callMessages[0].role).toBe("system")
    expect(callMessages[0].content).toContain("翻译专家")
    // Second message should be the user task
    expect(callMessages[1].role).toBe("user")
    expect(callMessages[1].content).toContain("翻译 hello")
  })

  it("includes context in user message when provided", async () => {
    const chatFn = vi.fn().mockResolvedValue({ content: "done" })
    setMultiAgentRuntime({
      chatFn,
      toolRegistry: { get: () => null, list: () => [] },
    } as any)

    const tool = registry.get("delegate_to")!
    await tool.handler(
      { target: "translator", task: "翻译", context: "原文是 Hello World" },
      ctx(),
    )

    await new Promise((r) => setTimeout(r, 100))

    const callMessages = chatFn.mock.calls[0][0]
    const userMsg = callMessages[1].content
    expect(userMsg).toContain("翻译")
    expect(userMsg).toContain("原文是 Hello World")
  })
})
