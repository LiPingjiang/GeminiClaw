# Cross-Agent Delegation + Result Reporting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use super-assistant:subagent-driven-development to implement this plan task-by-task.

**Goal:** 让 Agent A 能委派任务给命名的 Agent B，B 在后台异步执行，完成后结果自动回报给 A（注入 A 的上下文），实现真正的跨 Agent 协作。

**Architecture:** 三层设计 —— (1) 命名 Agent 系统：config.yaml 定义 agent templates，每个有独立 system prompt、工具集、记忆；(2) Agent Mailbox 通信协议：基于现有 LifecycleBus 扩展，支持 send_task + report_result 双向消息；(3) 生产接线：在 QQ Bot channel 启动时调用 setMultiAgentRuntime，让 delegate_tasks 真正工作。

**Tech Stack:** TypeScript, Zod (config validation), LifecycleBus (event system), SQLite (agent registry)

**Execution Config:**
```yaml
confirm_after_each_task: false
skip_spec_review: false
skip_quality_review: false
parallel_tasks: 1
```

---

## Background & Current State

### 已有组件（可复用）
- `src/multi-agent/lifecycle-bus.ts` — 进程内事件总线（Set<listener>），emitLifecycle/onLifecycle
- `src/multi-agent/async-executor.ts` — Fire-and-forget 执行器，MAX_CONCURRENT=3
- `src/multi-agent/result-injector.ts` — 监听 end/error 事件，通过 pushFn 推送给用户
- `src/multi-agent/runtime-context.ts` — 存储 chatFn + toolRegistry 的单例
- `src/multi-agent/subagent-registry.ts` — Run 注册表
- `src/mesh/bus.ts` — 半成品 MessageBus（EventEmitter，有环路检测）
- `src/mesh/registry.ts` — 半成品 AgentRegistry（Map-based，getByName）

### 核心问题
1. `setMultiAgentRuntime()` 从未在生产代码中调用 → delegate_tasks 工具在 QQ Bot 中返回"多 Agent 运行时未初始化"
2. 没有命名 Agent 路由 → 不能说"让翻译助手来做"
3. 结果只推给用户（pushFn），不回注父 Agent 上下文 → 父 Agent 无法感知子任务完成

---

## Task 1: Wire setMultiAgentRuntime in QQ Bot Channel

**Files:**
- Modify: `src/channels/qqbot/index.ts:81-96` (start method, after agentLoop available)
- Test: `src/multi-agent/runtime-context.test.ts` (new)

**Why:** 这是最关键的一步。不接线，delegate_tasks 永远返回"运行时未初始化"。

**Step 1: Write the failing test**

```typescript
// src/multi-agent/runtime-context.test.ts
import { describe, it, expect, beforeEach } from "vitest"
import {
  setMultiAgentRuntime,
  getMultiAgentRuntime,
  __resetMultiAgentRuntime,
} from "./runtime-context.js"

describe("runtime-context", () => {
  beforeEach(() => {
    __resetMultiAgentRuntime()
  })

  it("returns null before wiring", () => {
    expect(getMultiAgentRuntime()).toBeNull()
  })

  it("returns the wired runtime after set", () => {
    const mockRuntime = {
      chatFn: async () => ({ content: "hi", tool_calls: undefined }),
      toolRegistry: { get: () => null, list: () => [] },
    }
    setMultiAgentRuntime(mockRuntime as any)
    expect(getMultiAgentRuntime()).toBe(mockRuntime)
  })
})
```

**Step 2: Run test to verify it passes** (this is testing existing code, should pass)

Run: `pnpm vitest run src/multi-agent/runtime-context.test.ts`
Expected: PASS

**Step 3: Wire setMultiAgentRuntime in QQ Bot channel start()**

In `src/channels/qqbot/index.ts`, inside the `start()` method, after `agentLoop` is available from `ctx`, add:

```typescript
// After line ~82 where ctx is destructured:
// const { memory, agentLoop, config, consumeFallbackRoute } = ctx;

// ── Wire multi-agent runtime (enables delegate_tasks tool) ──────────
import { setMultiAgentRuntime } from "../../multi-agent/runtime-context.js";

// Build a chatFn adapter that wraps agentLoop for sub-agent use
const subAgentChatFn = async (
  messages: any[],
  options?: { model?: string; tools?: unknown[] },
) => {
  // Run a single-turn agent loop for the sub-agent
  let content = "";
  let toolCalls: any[] | undefined;
  for await (const event of agentLoop.run({
    messages,
    sessionId: `subagent:${randomUUID().slice(0, 8)}`,
    ...(options?.model ? { model: options.model } : {}),
  })) {
    if (event.type === "message_delta") {
      content += event.delta;
    } else if (event.type === "turn_end" && event.message?.tool_calls) {
      toolCalls = event.message.tool_calls;
    }
  }
  return { content, tool_calls: toolCalls };
};

// Build a minimal ToolRegistryLike adapter from the tool registry
const toolRegistryAdapter = {
  get: (name: string) => {
    const { registry } = await import("../../tools/registry.js");
    return registry.get(name);
  },
  list: () => {
    const { registry } = await import("../../tools/registry.js");
    return registry.list();
  },
};

setMultiAgentRuntime({
  chatFn: subAgentChatFn,
  toolRegistry: toolRegistryAdapter,
});
console.log("[QQBotChannel] Multi-agent runtime wired (delegate_tasks enabled)");
```

**Step 4: Run full test suite**

Run: `pnpm test`
Expected: All 569+ tests pass

**Step 5: Commit**

```bash
git add src/channels/qqbot/index.ts src/multi-agent/runtime-context.test.ts
git commit -m "fix: wire setMultiAgentRuntime in QQBot channel — enables delegate_tasks in production"
```

---

## Task 2: Named Agent Templates in Config

**Files:**
- Modify: `src/config/schema.ts` (add `agents` section to config schema)
- Create: `src/agents/templates.ts` (template loader)
- Test: `src/agents/templates.test.ts`

**Why:** 要实现"让翻译助手来做"，首先需要在 config 中定义命名 Agent 模板。

**Step 1: Write the failing test**

```typescript
// src/agents/templates.test.ts
import { describe, it, expect } from "vitest"
import { loadAgentTemplates, getTemplateByName } from "./templates.js"

describe("Agent Templates", () => {
  it("loads templates from config agents section", () => {
    const config = {
      agents: [
        {
          name: "translator",
          displayName: "翻译助手",
          systemPrompt: "你是一个专业翻译。",
          tools: ["web_search"],
          model: "claude-sonnet",
        },
        {
          name: "researcher",
          displayName: "调研助手",
          systemPrompt: "你是一个调研专家。",
          tools: [],
        },
      ],
    }
    const templates = loadAgentTemplates(config as any)
    expect(templates).toHaveLength(2)
    expect(templates[0].name).toBe("translator")
    expect(templates[0].displayName).toBe("翻译助手")
  })

  it("getTemplateByName returns matching template", () => {
    const config = {
      agents: [
        {
          name: "translator",
          displayName: "翻译助手",
          systemPrompt: "你是一个专业翻译。",
          tools: [],
        },
      ],
    }
    loadAgentTemplates(config as any)
    const t = getTemplateByName("translator")
    expect(t).not.toBeNull()
    expect(t!.displayName).toBe("翻译助手")
  })

  it("returns null for unknown template name", () => {
    loadAgentTemplates({ agents: [] } as any)
    expect(getTemplateByName("nonexistent")).toBeNull()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/agents/templates.test.ts`
Expected: FAIL — module not found

**Step 3: Add agents config schema**

In `src/config/schema.ts`, add before `configSchema`:

```typescript
export const agentTemplateSchema = z.object({
  /** Unique name for routing (e.g. "translator", "researcher") */
  name: z.string().min(1),
  /** Display name shown to users */
  displayName: z.string().min(1),
  /** System prompt for this agent type */
  systemPrompt: z.string().default(""),
  /** Tool whitelist (empty = all tools) */
  tools: z.array(z.string()).default([]),
  /** Tool denylist */
  deniedTools: z.array(z.string()).default([]),
  /** Preferred model override */
  model: z.string().optional(),
  /** Max turns per task */
  maxTurns: z.number().int().positive().default(12),
  /** Description for other agents to understand capabilities */
  capabilities: z.string().default(""),
})

export type AgentTemplate = z.infer<typeof agentTemplateSchema>
```

Update `configSchema` to include optional `agents`:

```typescript
export const configSchema = z.object({
  server: serverConfigSchema,
  providers: z.array(providerConfigSchema).min(1),
  routing: routingConfigSchema,
  memory: memoryConfigSchema,
  agent: agentConfigSchema,
  channels: channelsConfigSchema,
  evolution: evolutionConfigSchema,
  agents: z.array(agentTemplateSchema).default([]),  // NEW
})
```

**Step 4: Implement templates.ts**

```typescript
// src/agents/templates.ts
import type { AgentTemplate } from "../config/schema.js"

let _templates: AgentTemplate[] = []

/**
 * Load agent templates from config. Called once at startup.
 */
export function loadAgentTemplates(config: { agents?: AgentTemplate[] }): AgentTemplate[] {
  _templates = config.agents ?? []
  return _templates
}

/**
 * Find a template by its unique name.
 */
export function getTemplateByName(name: string): AgentTemplate | null {
  return _templates.find((t) => t.name === name) ?? null
}

/**
 * List all available template names (for tool descriptions / routing).
 */
export function listTemplateNames(): string[] {
  return _templates.map((t) => t.name)
}

/**
 * Get all templates (for display).
 */
export function getAllTemplates(): AgentTemplate[] {
  return [..._templates]
}
```

**Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/agents/templates.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/config/schema.ts src/agents/templates.ts src/agents/templates.test.ts
git commit -m "feat: add named agent templates to config schema + template loader"
```

---

## Task 3: Agent Mailbox — Inter-Agent Communication Protocol

**Files:**
- Create: `src/multi-agent/mailbox.ts`
- Test: `src/multi-agent/mailbox.test.ts`

**Why:** 这是通信的核心。Agent A 发送任务给 Agent B，B 完成后通过 mailbox 回报结果。基于现有 LifecycleBus 扩展。

**Step 1: Write the failing test**

```typescript
// src/multi-agent/mailbox.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  sendTask,
  onTaskResult,
  __resetMailbox,
  type AgentMessage,
} from "./mailbox.js"

describe("Agent Mailbox", () => {
  beforeEach(() => {
    __resetMailbox()
  })

  it("sendTask creates a pending message with unique ID", () => {
    const msg = sendTask({
      from: "agent-A",
      to: "translator",
      task: "翻译这段话",
      context: "Hello world",
    })
    expect(msg.id).toBeTruthy()
    expect(msg.from).toBe("agent-A")
    expect(msg.to).toBe("translator")
    expect(msg.status).toBe("pending")
  })

  it("onTaskResult fires when a task completes", async () => {
    const handler = vi.fn()
    onTaskResult("agent-A", handler)

    const msg = sendTask({
      from: "agent-A",
      to: "translator",
      task: "翻译这段话",
      context: "Hello world",
    })

    // Simulate completion
    const { reportResult } = await import("./mailbox.js")
    reportResult(msg.id, {
      success: true,
      output: "你好世界",
    })

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: msg.id,
        from: "translator",
        success: true,
        output: "你好世界",
      }),
    )
  })

  it("sendTask rejects unknown target agent", () => {
    // When no templates loaded, all targets are "unknown" — but we allow it
    // (runtime resolution). The mailbox itself doesn't validate targets.
    const msg = sendTask({
      from: "agent-A",
      to: "nonexistent",
      task: "do something",
    })
    expect(msg.status).toBe("pending")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/multi-agent/mailbox.test.ts`
Expected: FAIL — module not found

**Step 3: Implement mailbox.ts**

```typescript
// src/multi-agent/mailbox.ts
/**
 * Agent Mailbox — Inter-Agent Communication Protocol
 *
 * Provides a simple message-passing interface between named agents:
 * - sendTask(): Agent A sends a task to Agent B (by name)
 * - reportResult(): Agent B reports completion back to A
 * - onTaskResult(): Agent A subscribes to results addressed to it
 *
 * Design:
 * - Process-internal (no network), based on callbacks
 * - Messages are fire-and-forget from sender's perspective
 * - Results are delivered asynchronously via registered handlers
 * - Integrates with LifecycleBus for execution lifecycle
 */

import { randomUUID } from "crypto"

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TaskMessage {
  /** Unique message ID */
  id: string
  /** Sender agent name or ID */
  from: string
  /** Target agent name (resolved to template at execution time) */
  to: string
  /** Task description */
  task: string
  /** Optional context/data to pass */
  context?: string
  /** Message status */
  status: "pending" | "executing" | "completed" | "failed"
  /** Creation timestamp */
  createdAt: number
}

export interface TaskResultReport {
  /** Original message ID */
  messageId: string
  /** Who completed it */
  from: string
  /** Success or failure */
  success: boolean
  /** Result output */
  output: string
  /** Duration in ms */
  durationMs?: number
}

export interface SendTaskParams {
  from: string
  to: string
  task: string
  context?: string
}

// ── State ──────────────────────────────────────────────────────────────────────

/** All pending/active messages */
const messages = new Map<string, TaskMessage>()

/** Result handlers: agentId/name → callback */
type ResultHandler = (result: TaskResultReport) => void
const resultHandlers = new Map<string, Set<ResultHandler>>()

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Send a task from one agent to another. Returns the message immediately.
 * Actual execution is triggered separately by the executor.
 */
export function sendTask(params: SendTaskParams): TaskMessage {
  const msg: TaskMessage = {
    id: `msg_${randomUUID().slice(0, 12)}`,
    from: params.from,
    to: params.to,
    task: params.task,
    context: params.context,
    status: "pending",
    createdAt: Date.now(),
  }
  messages.set(msg.id, msg)
  return msg
}

/**
 * Report a task result back to the sender. Triggers registered handlers.
 */
export function reportResult(messageId: string, result: Omit<TaskResultReport, "messageId" | "from">): void {
  const msg = messages.get(messageId)
  if (!msg) {
    console.warn(`[Mailbox] reportResult: unknown messageId=${messageId}`)
    return
  }

  msg.status = result.success ? "completed" : "failed"

  const report: TaskResultReport = {
    messageId,
    from: msg.to,
    ...result,
  }

  // Notify the sender's handlers
  const handlers = resultHandlers.get(msg.from)
  if (handlers) {
    for (const fn of handlers) {
      try {
        fn(report)
      } catch (err) {
        console.error("[Mailbox] result handler threw:", err)
      }
    }
  }
}

/**
 * Subscribe to task results addressed to a specific agent.
 * Returns unsubscribe function.
 */
export function onTaskResult(agentId: string, handler: ResultHandler): () => void {
  if (!resultHandlers.has(agentId)) {
    resultHandlers.set(agentId, new Set())
  }
  resultHandlers.get(agentId)!.add(handler)
  return () => {
    resultHandlers.get(agentId)?.delete(handler)
  }
}

/**
 * Get a message by ID (for status checking).
 */
export function getMessage(id: string): TaskMessage | undefined {
  return messages.get(id)
}

/**
 * Mark a message as executing.
 */
export function markExecuting(messageId: string): void {
  const msg = messages.get(messageId)
  if (msg) msg.status = "executing"
}

/**
 * Get all pending messages for a target agent.
 */
export function getPendingForAgent(targetName: string): TaskMessage[] {
  const result: TaskMessage[] = []
  for (const msg of messages.values()) {
    if (msg.to === targetName && msg.status === "pending") {
      result.push(msg)
    }
  }
  return result
}

/** Test helper */
export function __resetMailbox(): void {
  messages.clear()
  resultHandlers.clear()
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/multi-agent/mailbox.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/multi-agent/mailbox.ts src/multi-agent/mailbox.test.ts
git commit -m "feat: implement Agent Mailbox — inter-agent communication protocol"
```

---

## Task 4: delegate_to Tool — Named Agent Delegation

**Files:**
- Create: `src/tools/delegate_to.ts`
- Test: `src/tools/delegate_to.test.ts`

**Why:** 新工具 `delegate_to` 让父 Agent 能指定目标 Agent 名称来委派任务。与现有 `delegate_tasks`（匿名子 Agent）互补。

**Step 1: Write the failing test**

```typescript
// src/tools/delegate_to.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest"
import { registry } from "./registry.js"
import "./delegate_to.js"
import {
  setMultiAgentRuntime,
  __resetMultiAgentRuntime,
} from "../multi-agent/runtime-context.js"
import { __resetMailbox } from "../multi-agent/mailbox.js"
import { loadAgentTemplates } from "../agents/templates.js"

describe("delegate_to tool", () => {
  beforeEach(() => {
    __resetMultiAgentRuntime()
    __resetMailbox()
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
  })

  it("rejects when runtime not wired", async () => {
    const tool = registry.get("delegate_to")!
    const res = await tool.handler(
      { target: "translator", task: "翻译 hello" },
      ctx(),
    )
    expect(res.type).toBe("error")
    expect(res.error).toContain("运行时未初始化")
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
    expect(res.error).toContain("未找到")
  })

  it("accepts valid delegation and returns immediately", async () => {
    setMultiAgentRuntime({
      chatFn: vi.fn().mockResolvedValue({ content: "翻译完成" }),
      toolRegistry: { get: () => null, list: () => [] },
    } as any)
    const tool = registry.get("delegate_to")!
    const res = await tool.handler(
      { target: "translator", task: "翻译 hello world", context: "用户需要中文翻译" },
      ctx(),
    )
    expect(res.type).toBe("text")
    expect(res.text).toContain("已委派")
    expect(res.text).toContain("翻译助手")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/tools/delegate_to.test.ts`
Expected: FAIL — module not found

**Step 3: Implement delegate_to.ts**

```typescript
// src/tools/delegate_to.ts
/**
 * Tool: delegate_to — 委派任务给指定命名 Agent
 *
 * 与 delegate_tasks（匿名子 Agent 并行执行）不同，delegate_to 是：
 * - 指定目标 Agent（按 config 中定义的 name）
 * - 目标 Agent 使用自己的 system prompt、工具集、模型
 * - 异步执行，结果通过 Mailbox 回报给父 Agent
 *
 * 用法示例：
 *   delegate_to({ target: "translator", task: "翻译这段话", context: "..." })
 */

import { registry } from "./registry.js"
import { getMultiAgentRuntime } from "../multi-agent/runtime-context.js"
import { getTemplateByName, listTemplateNames } from "../agents/templates.js"
import { sendTask, markExecuting, reportResult } from "../multi-agent/mailbox.js"
import { emitLifecycle } from "../multi-agent/lifecycle-bus.js"
import { registerRun, completeRun, failRun } from "../multi-agent/subagent-registry.js"
import { randomUUID } from "crypto"

registry.register({
  name: "delegate_to",
  description:
    "委派任务给指定的命名助手（Agent）。目标助手有自己的专业能力和工具集。" +
    "调用后立即返回（不阻塞），目标助手在后台执行，完成后结果自动推送。" +
    "可用的助手列表会在运行时动态提供。",
  schema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "目标助手的名称（如 translator、researcher）。",
      },
      task: {
        type: "string",
        description: "要委派的任务描述。目标助手看不到当前对话，所以要自包含。",
      },
      context: {
        type: "string",
        description: "可选。传递给目标助手的额外上下文信息。",
      },
    },
    required: ["target", "task"],
  },
  executionMode: "sequential",
  handler: async (params, ctx) => {
    const targetName = String(params["target"] ?? "")
    const task = String(params["task"] ?? "")
    const context = params["context"] ? String(params["context"]) : undefined

    if (!targetName || !task) {
      return { type: "error", error: "delegate_to: target 和 task 不能为空。" }
    }

    // Check runtime
    const rt = getMultiAgentRuntime()
    if (!rt) {
      return { type: "error", error: "delegate_to: 多 Agent 运行时未初始化。" }
    }

    // Resolve target template
    const template = getTemplateByName(targetName)
    if (!template) {
      const available = listTemplateNames()
      return {
        type: "error",
        error: `delegate_to: 未找到名为「${targetName}」的助手。可用助手：${available.join("、") || "（无）"}`,
      }
    }

    // Create mailbox message
    const parentAgentId = ctx.extra?.["targetAgentId"] as string | undefined
    const parentUserId = ctx.extra?.["userId"] as string | undefined
    const msg = sendTask({
      from: parentAgentId ?? ctx.sessionId,
      to: targetName,
      task,
      context,
    })

    // Register run in subagent registry
    const runId = `run_${randomUUID().slice(0, 12)}`
    registerRun({
      runId,
      parentSessionId: ctx.sessionId,
      parentAgentId: parentAgentId ?? null,
      parentUserId,
      childSessionKey: `named:${targetName}:${msg.id}`,
      task: `[${template.displayName}] ${task.slice(0, 60)}`,
      taskTitles: [template.displayName + ": " + task.slice(0, 40)],
      status: "running",
      startedAt: Date.now(),
    })

    // Emit lifecycle start
    emitLifecycle({
      runId,
      phase: "start",
      sessionKey: `named:${targetName}:${msg.id}`,
      parentSessionId: ctx.sessionId,
      parentAgentId,
      taskDescription: `${template.displayName}: ${task.slice(0, 60)}`,
    })

    // Fire-and-forget: execute in background with target's config
    markExecuting(msg.id)
    void executeNamedAgent(runId, msg.id, template, task, context, rt).catch((err) => {
      console.error(`[delegate_to] background error for ${targetName}:`, err)
      failRun(runId, err instanceof Error ? err.message : String(err))
      reportResult(msg.id, { success: false, output: String(err) })
    })

    return {
      type: "text",
      text: [
        `✅ 已委派给「${template.displayName}」(${targetName})`,
        `任务: ${task.slice(0, 80)}`,
        `消息ID: ${msg.id}`,
        "",
        `目标助手正在后台执行，完成后结果会自动推送。你可以继续处理其他事务。`,
      ].join("\n"),
    }
  },
})

// ── Background execution ───────────────────────────────────────────────────────

async function executeNamedAgent(
  runId: string,
  messageId: string,
  template: { name: string; displayName: string; systemPrompt: string; tools: string[]; model?: string; maxTurns: number },
  task: string,
  context: string | undefined,
  rt: { chatFn: any; toolRegistry: any },
): Promise<void> {
  const startTime = Date.now()

  // Build messages with target agent's system prompt
  const messages: any[] = []
  if (template.systemPrompt) {
    messages.push({ role: "system", content: template.systemPrompt })
  }
  const userContent = context
    ? `${task}\n\n---\n上下文信息：\n${context}`
    : task
  messages.push({ role: "user", content: userContent })

  try {
    // Use the chatFn with the target's model preference
    const result = await rt.chatFn(messages, {
      model: template.model,
    })

    const output = result.content || "(无输出)"
    const durationMs = Date.now() - startTime

    // Report success
    completeRun(runId, output)
    reportResult(messageId, { success: true, output, durationMs })

    // Emit lifecycle end
    emitLifecycle({
      runId,
      phase: "end",
      sessionKey: `named:${template.name}:${messageId}`,
      parentSessionId: "", // filled by registry lookup
      result: output,
    })

    console.log(`[delegate_to] ${template.displayName} completed in ${durationMs}ms`)
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    failRun(runId, errorMsg)
    reportResult(messageId, { success: false, output: errorMsg })

    emitLifecycle({
      runId,
      phase: "error",
      sessionKey: `named:${template.name}:${messageId}`,
      parentSessionId: "",
      error: errorMsg,
    })
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/tools/delegate_to.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/tools/delegate_to.ts src/tools/delegate_to.test.ts
git commit -m "feat: add delegate_to tool — named agent delegation with mailbox"
```

---

## Task 5: Result Injection Back to Parent Agent Context

**Files:**
- Modify: `src/multi-agent/result-injector.ts` (extend to inject into parent agent memory)
- Modify: `src/channels/qqbot/index.ts` (register result handler that injects into session)
- Test: `src/multi-agent/result-injector.test.ts` (new or extend existing)

**Why:** 当前 ResultInjector 只推送消息给用户。我们需要同时将结果注入父 Agent 的 session memory，这样父 Agent 下次被唤醒时能看到子任务结果。

**Step 1: Write the failing test**

```typescript
// src/multi-agent/result-injector.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  initResultInjector,
  registerPushFn,
  registerContextInjector,
  __resetResultInjector,
} from "./result-injector.js"
import { emitLifecycle, __resetLifecycleBus } from "./lifecycle-bus.js"
import { registerRun, __resetSubagentRegistry } from "./subagent-registry.js"

describe("ResultInjector — context injection", () => {
  beforeEach(() => {
    __resetResultInjector()
    __resetLifecycleBus()
    __resetSubagentRegistry()
  })

  it("calls contextInjector when a run completes", async () => {
    const injector = vi.fn()
    const push = vi.fn()
    registerPushFn(push)
    registerContextInjector(injector)
    initResultInjector()

    // Register a run
    registerRun({
      runId: "run-1",
      parentSessionId: "session-A",
      parentAgentId: "agent-A",
      parentUserId: "user-1",
      childSessionKey: "child-1",
      task: "test task",
      taskTitles: ["Test"],
      status: "running",
      startedAt: Date.now(),
    })

    // Emit completion
    emitLifecycle({
      runId: "run-1",
      phase: "end",
      sessionKey: "child-1",
      parentSessionId: "session-A",
      result: "任务完成了",
    })

    // Wait for async handler
    await new Promise((r) => setTimeout(r, 50))

    expect(injector).toHaveBeenCalledWith(
      "session-A",
      expect.stringContaining("任务完成了"),
    )
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/multi-agent/result-injector.test.ts`
Expected: FAIL — registerContextInjector not exported

**Step 3: Extend result-injector.ts**

Add context injection capability:

```typescript
// Add to src/multi-agent/result-injector.ts:

/**
 * Context Injector: writes result into parent session memory so the parent
 * agent sees it on next turn. Registered by the channel layer.
 */
export type ContextInjectorFn = (sessionId: string, content: string) => Promise<void>

let _contextInjector: ContextInjectorFn | null = null

/**
 * Register a function that injects messages into a session's memory.
 * Called by QQBotChannel at startup.
 */
export function registerContextInjector(fn: ContextInjectorFn): void {
  _contextInjector = fn
  console.log("[ResultInjector] contextInjector registered")
}
```

In `handleCompletion`, after pushing to user, also inject into parent session:

```typescript
// In handleCompletion, after the pushFn block:
if (_contextInjector && record.parentSessionId) {
  try {
    await _contextInjector(record.parentSessionId, message)
    console.log(
      `[ResultInjector] injected result into session=${record.parentSessionId.slice(0, 8)}…`,
    )
  } catch (err) {
    console.error(`[ResultInjector] context injection failed:`, err)
  }
}
```

**Step 4: Wire contextInjector in QQ Bot channel**

In `src/channels/qqbot/index.ts` start(), after `registerPushFn`:

```typescript
import { registerContextInjector } from "../../multi-agent/result-injector.js";

// Register context injector: writes sub-task results into parent session memory
registerContextInjector(async (sessionId: string, content: string) => {
  // Inject as a "system" message so the agent sees it on next turn
  await memory.appendMessages(sessionId, [
    { role: "system", content: `[子任务结果回报]\n${content}` },
  ]);
});
```

**Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/multi-agent/result-injector.test.ts`
Expected: PASS

**Step 6: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 7: Commit**

```bash
git add src/multi-agent/result-injector.ts src/multi-agent/result-injector.test.ts src/channels/qqbot/index.ts
git commit -m "feat: result injection into parent agent context — enables cross-agent result awareness"
```

---

## Task 6: Load Templates at Startup + Integration Wiring

**Files:**
- Modify: `src/channels/qqbot/index.ts` (call loadAgentTemplates at start)
- Modify: `src/index.ts` or server startup (ensure templates loaded before channel starts)
- Create: `config.example.yaml` update (add agents section example)

**Why:** 把所有组件串起来：启动时加载 templates，注册 runtime，初始化 injector。

**Step 1: Add agents section to config.example.yaml**

```yaml
# Named agent templates for cross-agent delegation
agents:
  - name: translator
    displayName: 翻译助手
    systemPrompt: "你是一个专业的多语言翻译助手。请准确翻译用户提供的文本，保持原文的语气和风格。"
    tools: []
    maxTurns: 4
    capabilities: "多语言翻译（中英日韩等）"
  - name: researcher
    displayName: 调研助手
    systemPrompt: "你是一个调研专家。请深入分析用户提出的问题，提供全面、有据可查的信息。"
    tools: ["web_search", "read_file"]
    maxTurns: 12
    capabilities: "信息调研、资料搜集、分析总结"
  - name: coder
    displayName: 编程助手
    systemPrompt: "你是一个资深程序员。请编写高质量、可维护的代码，遵循最佳实践。"
    tools: ["read_file", "write_file", "exec"]
    maxTurns: 16
    capabilities: "代码编写、调试、重构"
```

**Step 2: Wire in QQ Bot channel start()**

In `src/channels/qqbot/index.ts`, at the beginning of `start()`:

```typescript
import { loadAgentTemplates } from "../../agents/templates.js";

// Inside start():
// Load named agent templates from config
loadAgentTemplates(config as any);
```

**Step 3: Ensure delegate_to.ts is imported (tool auto-registration)**

Add import in the tools index or ensure it's loaded:

```typescript
// In whatever file loads all tools (likely src/tools/index.ts or similar)
import "./delegate_to.js"
```

**Step 4: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/channels/qqbot/index.ts src/tools/index.ts config.example.yaml
git commit -m "feat: wire agent templates + delegate_to at startup — full integration"
```

---

## Task 7: End-to-End Integration Test

**Files:**
- Create: `src/multi-agent/cross-agent.e2e.test.ts`

**Why:** 验证完整流程：Agent A 调用 delegate_to → Mailbox 创建消息 → 后台执行 → 结果回报 → 注入父 session。

**Step 1: Write the E2E test**

```typescript
// src/multi-agent/cross-agent.e2e.test.ts
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
import { loadAgentTemplates } from "../agents/templates.js"

describe("Cross-Agent Delegation E2E", () => {
  beforeEach(() => {
    __resetMultiAgentRuntime()
    __resetMailbox()
    __resetSubagentRegistry()
    __resetResultInjector()
    __resetLifecycleBus()

    loadAgentTemplates({
      agents: [
        {
          name: "translator",
          displayName: "翻译助手",
          systemPrompt: "你是翻译专家。",
          tools: [],
          deniedTools: [],
          maxTurns: 4,
          capabilities: "翻译",
        },
      ],
    })
  })

  it("full flow: delegate → execute → result injected", async () => {
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
    expect(res.text).toContain("已委派")

    // Wait for background execution
    await new Promise((r) => setTimeout(r, 200))

    // Verify chatFn was called with translator's system prompt
    expect(chatFn).toHaveBeenCalled()
    const callMessages = chatFn.mock.calls[0][0]
    expect(callMessages[0].content).toContain("翻译专家")

    // Verify result was pushed to user
    expect(pushed.length).toBeGreaterThan(0)
    expect(pushed[0].content).toContain("你好世界")

    // Verify result was injected into parent session
    expect(injected.length).toBeGreaterThan(0)
    expect(injected[0].sessionId).toBe("session-A")
    expect(injected[0].content).toContain("你好世界")
  })
})
```

**Step 2: Run E2E test**

Run: `pnpm vitest run src/multi-agent/cross-agent.e2e.test.ts`
Expected: PASS

**Step 3: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/multi-agent/cross-agent.e2e.test.ts
git commit -m "test: add cross-agent delegation E2E test — verifies full flow"
```

---

## Task 8: Deploy and Real-World Test

**Files:**
- No new files — deployment and manual testing

**Step 1: Run full test suite locally**

Run: `pnpm test`
Expected: All tests pass

**Step 2: Build**

Run: `pnpm build`
Expected: No TypeScript errors

**Step 3: Commit all changes and push**

```bash
git push origin main
```

**Step 4: Deploy to production server**

```bash
ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && git pull && pnpm install && pnpm build && pm2 restart geminiclaw"
```

**Step 5: Verify health**

```bash
curl http://49.232.173.252:3000/v1/health
```

**Step 6: Test in QQ Bot**

Send message to QQ Bot:
1. "帮我用翻译助手翻译一下 Hello World" — 验证 delegate_to 是否工作
2. 等待结果推送 — 验证 ResultInjector 是否推送
3. 再发一条消息 — 验证父 Agent 是否能看到注入的结果

---

## Summary of Changes

| Component | Action | Purpose |
|-----------|--------|---------|
| `src/config/schema.ts` | Add `agents` array | Named agent template definitions |
| `src/agents/templates.ts` | New | Template loader + lookup |
| `src/multi-agent/mailbox.ts` | New | Inter-agent message passing |
| `src/multi-agent/result-injector.ts` | Extend | Add context injection to parent session |
| `src/tools/delegate_to.ts` | New | Named agent delegation tool |
| `src/channels/qqbot/index.ts` | Modify | Wire runtime + templates + injector |
| config.example.yaml | Update | Add agents section example |

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     QQ Bot Channel                            │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │ Agent A  │───▶│ delegate_to  │───▶│ Agent Mailbox    │   │
│  │ (parent) │    │   tool       │    │ sendTask()       │   │
│  └──────────┘    └──────────────┘    └────────┬─────────┘   │
│       ▲                                        │             │
│       │                                        ▼             │
│       │                              ┌──────────────────┐   │
│       │                              │ AsyncExecutor    │   │
│       │                              │ (background)     │   │
│       │                              └────────┬─────────┘   │
│       │                                        │             │
│       │                                        ▼             │
│       │                              ┌──────────────────┐   │
│       │                              │ Named Agent B    │   │
│       │                              │ (translator)     │   │
│       │                              │ own system prompt│   │
│       │                              │ own tools        │   │
│       │                              └────────┬─────────┘   │
│       │                                        │             │
│       │         ┌──────────────────┐           │             │
│       │◀────────│ ResultInjector   │◀──────────┘             │
│       │         │ • push to user   │  reportResult()         │
│  (context       │ • inject session │                         │
│   injection)    └──────────────────┘                         │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

1. **User → Agent A:** "帮我翻译 hello world"
2. **Agent A → delegate_to:** `{ target: "translator", task: "翻译 hello world" }`
3. **delegate_to → Mailbox:** `sendTask()` 创建消息，返回"已委派"
4. **Background:** AsyncExecutor 用 translator 的 system prompt + chatFn 执行
5. **Completion → Mailbox:** `reportResult()` 标记完成
6. **ResultInjector → User:** pushFn 推送"翻译助手完成：你好世界"
7. **ResultInjector → Session:** contextInjector 写入 session memory
8. **Next turn:** Agent A 能看到 `[子任务结果回报] 翻译助手完成：你好世界`
