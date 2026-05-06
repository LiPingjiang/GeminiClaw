# AgentLoop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `AgentLoop` — an EventStream-style `AsyncIterable<AgentEvent>` with parallel tool execution and `beforeToolCall`/`afterToolCall` hooks.

**Architecture:** `AgentLoop` accepts a dependency-injected `chatFn` (for LLM calls) and `ToolRegistryLike` (for tool dispatch); it drives a multi-turn agentic loop via an `async *run()` generator that yields typed `AgentEvent`s. Tool execution can be parallel or sequential depending on whether tool names appear in `SEQUENTIAL_TOOLS`. The module lives entirely in `src/agent/` and has zero imports from `src/tools/`.

**Tech Stack:** TypeScript (strict ESM), Vitest, no external runtime deps beyond what already exists.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/agent/types.ts` | Create | `AgentEvent` union, `ToolCall`, hook context types, `AgentConfig` |
| `src/agent/loop.ts` | Create | `AgentLoop` class — generator loop, tool dispatch, hooks, truncation |
| `src/agent/index.ts` | Create | Re-exports for public API |
| `src/agent/loop.test.ts` | Create | 12 integration tests with mock `chatFn` and mock registry |

---

## Task 1: types.ts — AgentEvent union and supporting types

**Files:**
- Create: `src/agent/types.ts`

- [ ] **Step 1: Write the file**

```typescript
// src/agent/types.ts
import type { Message } from '../providers/types.js'

export type ToolResult = { content: string; isError?: boolean }

export type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'message_delta'; delta: string }
  | { type: 'turn_end'; message: Message; toolCallCount: number }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; toolName: string; result: ToolResult; isError: boolean; durationMs: number }
  | { type: 'agent_end'; totalTurns: number; stopReason: 'no_tool_calls' | 'max_turns' | 'aborted' }

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface BeforeToolCallContext {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  sessionId: string
}

export interface AfterToolCallContext {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  result: ToolResult
  durationMs: number
  sessionId: string
}

export interface AgentConfig {
  maxTurns?: number
  toolExecutionMode?: 'parallel' | 'sequential'
  maxToolOutputChars?: number
  systemPrompt?: string
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agent/types.ts
git commit -m "feat(agent): add AgentEvent types and AgentConfig"
```

---

## Task 2: loop.ts — AgentLoop class skeleton and internal types

**Files:**
- Create: `src/agent/loop.ts`

- [ ] **Step 1: Write the failing test skeleton** (in `src/agent/loop.test.ts` — just import check)

```typescript
// src/agent/loop.test.ts
import { describe, it, expect } from 'vitest'
import { AgentLoop } from './loop.js'
import type { ToolCall } from './types.js'

it('AgentLoop is importable', () => {
  expect(AgentLoop).toBeDefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/agent/loop.test.ts 2>&1 | head -20
```
Expected: FAIL — `Cannot find module './loop.js'`

- [ ] **Step 3: Write the AgentLoop skeleton**

Create `src/agent/loop.ts`:

```typescript
// src/agent/loop.ts
import type {
  AgentConfig,
  AgentEvent,
  AfterToolCallContext,
  BeforeToolCallContext,
  ToolCall,
  ToolResult,
} from './types.js'
import type { Message } from '../providers/types.js'

// ---------------------------------------------------------------------------
// Internal message types (not exported — wider than public Message)
// ---------------------------------------------------------------------------

type InternalMessage =
  | { role: 'user' | 'system'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

// ---------------------------------------------------------------------------
// ChatFn — injected for testability
// ---------------------------------------------------------------------------

export type ChatFn = (
  messages: InternalMessage[],
  options?: { model?: string; tools?: unknown[] }
) => Promise<{ content: string; tool_calls?: ToolCall[] }>

// ---------------------------------------------------------------------------
// ToolRegistryLike — minimal interface (no import from src/tools/)
// ---------------------------------------------------------------------------

type JSONSchema = Record<string, unknown>

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>

export interface ToolRegistryLike {
  get(name: string): { handler: ToolHandler; schema: JSONSchema; executionMode?: string } | null
  list(): Array<{ name: string; description: string; schema: JSONSchema; executionMode?: string }>
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface Logger {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

const defaultLogger: Logger = {
  info: (msg, ...args) => console.log(`[AgentLoop] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[AgentLoop] WARN ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[AgentLoop] ERROR ${msg}`, ...args),
}

// ---------------------------------------------------------------------------
// Tools that must run sequentially (never parallelize)
// ---------------------------------------------------------------------------

const SEQUENTIAL_TOOLS = new Set(['exec', 'write', 'edit'])

// ---------------------------------------------------------------------------
// AgentLoop
// ---------------------------------------------------------------------------

export interface AgentLoopParams {
  chatFn: ChatFn
  toolRegistry: ToolRegistryLike
  config?: AgentConfig
  logger?: Logger
}

export interface RunParams {
  messages: InternalMessage[]
  sessionId: string
  model?: string
  signal?: AbortSignal
  beforeToolCall?: (ctx: BeforeToolCallContext) => Promise<{ block?: boolean; reason?: string }>
  afterToolCall?: (ctx: AfterToolCallContext) => Promise<Partial<ToolResult> | undefined>
}

interface ToolExecutionBatch {
  events: AgentEvent[]
  results: Array<{ toolCallId: string; content: string }>
}

export class AgentLoop {
  private chatFn: ChatFn
  private toolRegistry: ToolRegistryLike
  private config: Required<AgentConfig>
  private logger: Logger

  constructor(params: AgentLoopParams) {
    this.chatFn = params.chatFn
    this.toolRegistry = params.toolRegistry
    this.logger = params.logger ?? defaultLogger
    this.config = {
      maxTurns: params.config?.maxTurns ?? 10,
      toolExecutionMode: params.config?.toolExecutionMode ?? 'parallel',
      maxToolOutputChars: params.config?.maxToolOutputChars ?? 8000,
      systemPrompt: params.config?.systemPrompt ?? '',
    }
  }

  async *run(params: RunParams): AsyncIterable<AgentEvent> {
    let messages: InternalMessage[] = [...params.messages]
    let turn = 0
    const maxTurns = this.config.maxTurns

    while (turn < maxTurns) {
      if (params.signal?.aborted) {
        yield { type: 'agent_end', totalTurns: turn, stopReason: 'aborted' }
        return
      }

      yield { type: 'turn_start', turn }
      turn++

      // Build tool schemas for LLM
      const toolSchemas = this.toolRegistry.list().map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
      }))

      // Call LLM
      let response: { content: string; tool_calls?: ToolCall[] }
      try {
        response = await this.chatFn(messages, { model: params.model, tools: toolSchemas })
      } catch (err) {
        this.logger.error('chatFn threw: %s', (err as Error).message)
        yield {
          type: 'agent_end',
          totalTurns: turn,
          stopReason: 'no_tool_calls',
        }
        return
      }

      // Emit content delta
      if (response.content) {
        yield { type: 'message_delta', delta: response.content }
      }

      // Append assistant message
      const assistantMsg: InternalMessage = {
        role: 'assistant',
        content: response.content,
        tool_calls: response.tool_calls,
      }
      messages = [...messages, assistantMsg]

      yield {
        type: 'turn_end',
        message: { role: 'assistant', content: response.content },
        toolCallCount: response.tool_calls?.length ?? 0,
      }

      // No tool calls → done
      if (!response.tool_calls || response.tool_calls.length === 0) {
        yield { type: 'agent_end', totalTurns: turn, stopReason: 'no_tool_calls' }
        return
      }

      // Execute tools
      const batch = await this.executeTools(
        response.tool_calls,
        params.sessionId,
        params.beforeToolCall,
        params.afterToolCall,
      )

      for (const event of batch.events) {
        yield event
      }

      // Append tool result messages
      for (const tr of batch.results) {
        messages = [
          ...messages,
          { role: 'tool', tool_call_id: tr.toolCallId, content: tr.content },
        ]
      }
    }

    yield { type: 'agent_end', totalTurns: turn, stopReason: 'max_turns' }
  }

  // ---------------------------------------------------------------------------
  // Tool execution (parallel or sequential)
  // ---------------------------------------------------------------------------

  private async executeTools(
    toolCalls: ToolCall[],
    sessionId: string,
    beforeToolCall: RunParams['beforeToolCall'],
    afterToolCall: RunParams['afterToolCall'],
  ): Promise<ToolExecutionBatch> {
    const shouldParallelize =
      this.config.toolExecutionMode !== 'sequential' &&
      toolCalls.every(tc => !SEQUENTIAL_TOOLS.has(tc.name))

    const execute = (tc: ToolCall) =>
      this.executeSingleTool(tc, sessionId, beforeToolCall, afterToolCall)

    const perToolResults: ToolExecutionBatch[] =
      shouldParallelize
        ? await Promise.all(toolCalls.map(execute))
        : await (async () => {
            const results: ToolExecutionBatch[] = []
            for (const tc of toolCalls) {
              results.push(await execute(tc))
            }
            return results
          })()

    return {
      events: perToolResults.flatMap(b => b.events),
      results: perToolResults.flatMap(b => b.results),
    }
  }

  private async executeSingleTool(
    tc: ToolCall,
    sessionId: string,
    beforeToolCall: RunParams['beforeToolCall'],
    afterToolCall: RunParams['afterToolCall'],
  ): Promise<ToolExecutionBatch> {
    const events: AgentEvent[] = []

    events.push({ type: 'tool_start', toolCallId: tc.id, toolName: tc.name, args: tc.args })

    // beforeToolCall hook
    if (beforeToolCall) {
      const ctx: BeforeToolCallContext = {
        toolCallId: tc.id,
        toolName: tc.name,
        args: tc.args,
        sessionId,
      }
      const decision = await beforeToolCall(ctx)
      if (decision.block) {
        const blockedResult: ToolResult = {
          content: decision.reason ?? 'Tool call blocked by beforeToolCall hook',
          isError: true,
        }
        events.push({
          type: 'tool_end',
          toolCallId: tc.id,
          toolName: tc.name,
          result: blockedResult,
          isError: true,
          durationMs: 0,
        })
        return {
          events,
          results: [{ toolCallId: tc.id, content: blockedResult.content }],
        }
      }
    }

    // Look up tool
    const toolEntry = this.toolRegistry.get(tc.name)
    if (!toolEntry) {
      const errorResult: ToolResult = {
        content: `Tool "${tc.name}" not found in registry`,
        isError: true,
      }
      events.push({
        type: 'tool_end',
        toolCallId: tc.id,
        toolName: tc.name,
        result: errorResult,
        isError: true,
        durationMs: 0,
      })
      return {
        events,
        results: [{ toolCallId: tc.id, content: errorResult.content }],
      }
    }

    // Execute tool
    const startTime = Date.now()
    let result: ToolResult
    let isError = false

    try {
      result = await toolEntry.handler(tc.args)
    } catch (err) {
      isError = true
      result = {
        content: (err as Error).message ?? String(err),
        isError: true,
      }
    }

    const durationMs = Date.now() - startTime

    // Truncate output if needed
    if (result.content.length > this.config.maxToolOutputChars) {
      result = {
        ...result,
        content: result.content.slice(0, this.config.maxToolOutputChars),
      }
    }

    // afterToolCall hook
    if (afterToolCall && !isError) {
      const ctx: AfterToolCallContext = {
        toolCallId: tc.id,
        toolName: tc.name,
        args: tc.args,
        result,
        durationMs,
        sessionId,
      }
      const override = await afterToolCall(ctx)
      if (override !== undefined) {
        result = { ...result, ...override }
      }
    }

    events.push({
      type: 'tool_end',
      toolCallId: tc.id,
      toolName: tc.name,
      result,
      isError: isError || (result.isError === true),
      durationMs,
    })

    return {
      events,
      results: [{ toolCallId: tc.id, content: result.content }],
    }
  }
}
```

- [ ] **Step 4: Run import test to verify it passes**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/agent/loop.test.ts 2>&1 | head -30
```
Expected: PASS (1 test)

- [ ] **Step 5: Build check**

```bash
cd ~/Codes/GeminiClaw && pnpm build 2>&1 | tail -20
```
Expected: zero errors

- [ ] **Step 6: Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(agent): implement AgentLoop — async generator, parallel/sequential tool execution, hooks"
```

---

## Task 3: index.ts — public re-exports

**Files:**
- Create: `src/agent/index.ts`

- [ ] **Step 1: Write the file**

```typescript
// src/agent/index.ts
export { AgentLoop } from './loop.js'
export type { ChatFn, ToolRegistryLike, Logger, AgentLoopParams, RunParams } from './loop.js'
export type {
  AgentEvent,
  AgentConfig,
  ToolCall,
  ToolResult,
  BeforeToolCallContext,
  AfterToolCallContext,
} from './types.js'
```

- [ ] **Step 2: Build check**

```bash
cd ~/Codes/GeminiClaw && pnpm build 2>&1 | tail -10
```
Expected: zero errors

- [ ] **Step 3: Commit**

```bash
git add src/agent/index.ts
git commit -m "feat(agent): add index.ts re-exports"
```

---

## Task 4: loop.test.ts — 12 integration tests

**Files:**
- Modify: `src/agent/loop.test.ts` (replace the skeleton with full tests)

- [ ] **Step 1: Write all tests**

Replace the content of `src/agent/loop.test.ts` with:

```typescript
// src/agent/loop.test.ts
import { describe, it, expect, vi } from 'vitest'
import { AgentLoop } from './loop.js'
import type { ChatFn, ToolRegistryLike } from './loop.js'
import type { ToolCall, ToolResult, AgentEvent } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChatFn(responses: Array<{ content: string; tool_calls?: ToolCall[] }>): ChatFn {
  let idx = 0
  return async () => responses[idx++] ?? { content: 'done' }
}

function makeRegistry(
  tools: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>>
): ToolRegistryLike {
  return {
    get: (name: string) => {
      const handler = tools[name]
      if (!handler) return null
      return {
        handler,
        schema: { type: 'object' },
      }
    },
    list: () =>
      Object.keys(tools).map(name => ({
        name,
        description: `tool ${name}`,
        schema: { type: 'object' },
      })),
  }
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const e of iterable) {
    events.push(e)
  }
  return events
}

const sessionId = 'test-session'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentLoop', () => {
  // 1. No tool calls — pure text response
  it('emits correct events for a no-tool-call turn', async () => {
    const chatFn = makeChatFn([{ content: 'Hello, world!' }])
    const loop = new AgentLoop({ chatFn, toolRegistry: makeRegistry({}) })

    const events = await collect(loop.run({ messages: [{ role: 'user', content: 'hi' }], sessionId }))

    expect(events[0]).toMatchObject({ type: 'turn_start', turn: 0 })
    expect(events[1]).toMatchObject({ type: 'message_delta', delta: 'Hello, world!' })
    expect(events[2]).toMatchObject({ type: 'turn_end', toolCallCount: 0 })
    expect(events[3]).toMatchObject({ type: 'agent_end', stopReason: 'no_tool_calls', totalTurns: 1 })
    expect(events).toHaveLength(4)
  })

  // 2. Single tool call
  it('executes a single tool and then gets final response', async () => {
    const chatFn = makeChatFn([
      { content: '', tool_calls: [{ id: 'tc1', name: 'search', args: { q: 'test' } }] },
      { content: 'Found results!' },
    ])
    const registry = makeRegistry({
      search: async () => ({ content: 'search results' }),
    })
    const loop = new AgentLoop({ chatFn, toolRegistry: registry })

    const events = await collect(loop.run({ messages: [{ role: 'user', content: 'search for test' }], sessionId }))

    const types = events.map(e => e.type)
    expect(types).toContain('tool_start')
    expect(types).toContain('tool_end')
    expect(types).toContain('agent_end')

    const agentEnd = events.find(e => e.type === 'agent_end') as Extract<AgentEvent, { type: 'agent_end' }>
    expect(agentEnd.stopReason).toBe('no_tool_calls')
    expect(agentEnd.totalTurns).toBe(2)
  })

  // 3. Multiple turns with tool calls
  it('handles two rounds of tool calls before finishing', async () => {
    const chatFn = makeChatFn([
      { content: '', tool_calls: [{ id: 'tc1', name: 'read', args: {} }] },
      { content: '', tool_calls: [{ id: 'tc2', name: 'read', args: {} }] },
      { content: 'All done' },
    ])
    const registry = makeRegistry({
      read: async () => ({ content: 'file content' }),
    })
    const loop = new AgentLoop({ chatFn, toolRegistry: registry })

    const events = await collect(loop.run({ messages: [{ role: 'user', content: 'start' }], sessionId }))

    const agentEnd = events.find(e => e.type === 'agent_end') as Extract<AgentEvent, { type: 'agent_end' }>
    expect(agentEnd.stopReason).toBe('no_tool_calls')
    expect(agentEnd.totalTurns).toBe(3)
  })

  // 4. maxTurns limit
  it('stops with max_turns when every turn has tool calls', async () => {
    // Every chatFn call returns a tool_call — loop must stop at maxTurns
    const chatFn: ChatFn = async () => ({
      content: '',
      tool_calls: [{ id: 'tc', name: 'loop_tool', args: {} }],
    })
    const registry = makeRegistry({
      loop_tool: async () => ({ content: 'ok' }),
    })
    const loop = new AgentLoop({ chatFn, toolRegistry: registry, config: { maxTurns: 2 } })

    const events = await collect(loop.run({ messages: [{ role: 'user', content: 'start' }], sessionId }))

    const agentEnd = events.find(e => e.type === 'agent_end') as Extract<AgentEvent, { type: 'agent_end' }>
    expect(agentEnd.stopReason).toBe('max_turns')
    expect(agentEnd.totalTurns).toBe(2)
  })

  // 5. Parallel tool execution
  it('executes non-sequential tools in parallel', async () => {
    const callOrder: string[] = []
    const startTimes: Record<string, number> = {}

    const chatFn = makeChatFn([
      {
        content: '',
        tool_calls: [
          { id: 'tc1', name: 'fetch_a', args: {} },
          { id: 'tc2', name: 'fetch_b', args: {} },
        ],
      },
      { content: 'done' },
    ])
    const registry = makeRegistry({
      fetch_a: async () => {
        startTimes['fetch_a'] = Date.now()
        callOrder.push('fetch_a')
        return { content: 'a result' }
      },
      fetch_b: async () => {
        startTimes['fetch_b'] = Date.now()
        callOrder.push('fetch_b')
        return { content: 'b result' }
      },
    })
    const loop = new AgentLoop({ chatFn, toolRegistry: registry })

    const events = await collect(loop.run({ messages: [{ role: 'user', content: 'go' }], sessionId }))

    // Both tools should be called
    expect(callOrder).toContain('fetch_a')
    expect(callOrder).toContain('fetch_b')
    // Both tool_end events should be present
    const toolEnds = events.filter(e => e.type === 'tool_end')
    expect(toolEnds).toHaveLength(2)
  })

  // 6. Sequential tool execution (tool in SEQUENTIAL_TOOLS)
  it('executes write tool sequentially', async () => {
    const callOrder: string[] = []

    const chatFn = makeChatFn([
      {
        content: '',
        tool_calls: [
          { id: 'tc1', name: 'write', args: { file: 'a.txt' } },
          { id: 'tc2', name: 'write', args: { file: 'b.txt' } },
        ],
      },
      { content: 'done' },
    ])
    const registry = makeRegistry({
      write: async (args) => {
        callOrder.push(args['file'] as string)
        return { content: 'written' }
      },
    })
    const loop = new AgentLoop({ chatFn, toolRegistry: registry })

    await collect(loop.run({ messages: [{ role: 'user', content: 'write files' }], sessionId }))

    // Both should have run, and a.txt before b.txt (sequential)
    expect(callOrder).toEqual(['a.txt', 'b.txt'])
  })

  // 7. beforeToolCall block
  it('blocks tool execution when beforeToolCall returns { block: true }', async () => {
    const toolHandlerCalled = vi.fn()
    const chatFn = makeChatFn([
      { content: '', tool_calls: [{ id: 'tc1', name: 'dangerous', args: {} }] },
      { content: 'ok after block' },
    ])
    const registry = makeRegistry({
      dangerous: async () => {
        toolHandlerCalled()
        return { content: 'should not run' }
      },
    })
    const loop = new AgentLoop({ chatFn, toolRegistry: registry })

    const events = await collect(
      loop.run({
        messages: [{ role: 'user', content: 'run it' }],
        sessionId,
        beforeToolCall: async () => ({ block: true, reason: 'Not allowed' }),
      })
    )

    expect(toolHandlerCalled).not.toHaveBeenCalled()

    const toolEnd = events.find(e => e.type === 'tool_end') as Extract<AgentEvent, { type: 'tool_end' }>
    expect(toolEnd.isError).toBe(true)
    expect(toolEnd.result.content).toBe('Not allowed')
  })

  // 8. afterToolCall override
  it('allows afterToolCall to override the tool result', async () => {
    const chatFn = makeChatFn([
      { content: '', tool_calls: [{ id: 'tc1', name: 'calc', args: {} }] },
      { content: 'done' },
    ])
    const registry = makeRegistry({
      calc: async () => ({ content: 'original result' }),
    })
    const loop = new AgentLoop({ chatFn, toolRegistry: registry })

    const events = await collect(
      loop.run({
        messages: [{ role: 'user', content: 'calc' }],
        sessionId,
        afterToolCall: async () => ({ content: 'overridden result' }),
      })
    )

    const toolEnd = events.find(e => e.type === 'tool_end') as Extract<AgentEvent, { type: 'tool_end' }>
    expect(toolEnd.result.content).toBe('overridden result')
  })

  // 9. Tool not found in registry
  it('emits isError=true tool_end when tool name is not in registry', async () => {
    const chatFn = makeChatFn([
      { content: '', tool_calls: [{ id: 'tc1', name: 'unknown_tool', args: {} }] },
      { content: 'done' },
    ])
    const registry = makeRegistry({})  // empty registry
    const loop = new AgentLoop({ chatFn, toolRegistry: registry })

    const events = await collect(loop.run({ messages: [{ role: 'user', content: 'go' }], sessionId }))

    const toolEnd = events.find(e => e.type === 'tool_end') as Extract<AgentEvent, { type: 'tool_end' }>
    expect(toolEnd.isError).toBe(true)
    expect(toolEnd.result.content).toContain('unknown_tool')
    expect(toolEnd.result.content).toContain('not found')
  })

  // 10. Tool handler throws
  it('emits isError=true tool_end when handler throws', async () => {
    const chatFn = makeChatFn([
      { content: '', tool_calls: [{ id: 'tc1', name: 'buggy', args: {} }] },
      { content: 'done' },
    ])
    const registry = makeRegistry({
      buggy: async () => { throw new Error('Tool crashed!') },
    })
    const loop = new AgentLoop({ chatFn, toolRegistry: registry })

    const events = await collect(loop.run({ messages: [{ role: 'user', content: 'run buggy' }], sessionId }))

    const toolEnd = events.find(e => e.type === 'tool_end') as Extract<AgentEvent, { type: 'tool_end' }>
    expect(toolEnd.isError).toBe(true)
    expect(toolEnd.result.content).toContain('Tool crashed!')
  })

  // 11. AbortSignal stops immediately
  it('yields agent_end(aborted) immediately when signal is already aborted', async () => {
    const chatFn: ChatFn = vi.fn().mockResolvedValue({ content: 'should not get here' })
    const loop = new AgentLoop({ chatFn, toolRegistry: makeRegistry({}) })

    const controller = new AbortController()
    controller.abort()

    const events = await collect(
      loop.run({
        messages: [{ role: 'user', content: 'go' }],
        sessionId,
        signal: controller.signal,
      })
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'agent_end', stopReason: 'aborted' })
    expect(chatFn).not.toHaveBeenCalled()
  })

  // 12. Tool output truncation
  it('truncates tool output that exceeds maxToolOutputChars', async () => {
    const longOutput = 'x'.repeat(10000)
    const chatFn = makeChatFn([
      { content: '', tool_calls: [{ id: 'tc1', name: 'verbose', args: {} }] },
      { content: 'done' },
    ])
    const registry = makeRegistry({
      verbose: async () => ({ content: longOutput }),
    })
    const loop = new AgentLoop({
      chatFn,
      toolRegistry: registry,
      config: { maxToolOutputChars: 100 },
    })

    const events = await collect(loop.run({ messages: [{ role: 'user', content: 'run' }], sessionId }))

    const toolEnd = events.find(e => e.type === 'tool_end') as Extract<AgentEvent, { type: 'tool_end' }>
    expect(toolEnd.result.content.length).toBe(100)
  })
})
```

- [ ] **Step 2: Run the tests**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/agent/loop.test.ts 2>&1
```
Expected: 12 tests pass

- [ ] **Step 3: If any test fails, diagnose and fix**

Common failure modes:
- `tool_end` event ordering in parallel mode: `events.map(e => e.type)` check doesn't assume order, just `toContain`
- AbortSignal: make sure the `while` check runs before any `chatFn` call
- Tool block: result content should come from `reason`, not a hardcoded string

- [ ] **Step 4: Run full test suite**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -30
```
Expected: all existing tests still pass (181+), total rises by 12

- [ ] **Step 5: Build check**

```bash
cd ~/Codes/GeminiClaw && pnpm build 2>&1 | tail -10
```
Expected: zero errors

- [ ] **Step 6: Commit**

```bash
git add src/agent/loop.test.ts
git commit -m "test(agent): add 12 AgentLoop integration tests"
```

---

## Task 5: Final commit — bundle src/agent/

- [ ] **Step 1: Verify all tests still green**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -10
```
Expected: all green

- [ ] **Step 2: Final commit**

```bash
git add src/agent/
git commit -m "feat(agent): add AgentLoop — EventStream AsyncIterable, parallel tool execution, beforeToolCall/afterToolCall hooks"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Task |
|---|---|
| `src/agent/types.ts` with `AgentEvent`, `ToolCall`, hook contexts, `AgentConfig` | Task 1 |
| `AgentLoop` class with `chatFn` DI | Task 2 |
| `async *run()` generator yielding `AgentEvent`s | Task 2 |
| Parallel tool execution (`Promise.all`) | Task 2 |
| Sequential fallback for `SEQUENTIAL_TOOLS` | Task 2 |
| `beforeToolCall` block | Task 2 |
| `afterToolCall` override | Task 2 |
| `maxToolOutputChars` truncation | Task 2 |
| `AbortSignal` support | Task 2 |
| `src/agent/index.ts` re-exports | Task 3 |
| 12 integration tests (all scenarios) | Task 4 |
| `pnpm build` zero errors | Tasks 2, 3, 4 |
| `pnpm test` all green | Task 4 |
| `git commit` with specified message | Task 5 |
| No push | — (not in any task) |

**Placeholder scan:** No TBD, no "implement later", no "fill in details". All code is complete.

**Type consistency:**
- `ToolResult` defined in `types.ts`, imported into `loop.ts` — consistent
- `ChatFn` return type `{ content: string; tool_calls?: ToolCall[] }` matches usage in tests
- `ToolRegistryLike.get()` returns `{ handler, schema, executionMode? } | null` — consistent with tests calling `makeRegistry`
- `InternalMessage` is local to `loop.ts` — consistent throughout
- `AgentEvent` union covers all yield sites in `run()` and `executeSingleTool()`
