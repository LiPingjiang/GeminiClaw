import { describe, it, expect, vi } from 'vitest'
import { AgentLoop } from './loop.js'
import type { ChatFn, ToolRegistryLike, InternalMessage } from './loop.js'
import type { ToolCall, ToolResult } from './types.js'

function makeMockChatFn(
  responses: Array<{ content: string; tool_calls?: ToolCall[] }>,
): ChatFn {
  let idx = 0
  return async () => {
    const resp = responses[idx++] ?? { content: 'done', tool_calls: [] }
    return resp
  }
}

function makeMockRegistry(
  tools: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>>,
): ToolRegistryLike {
  return {
    get(name: string) {
      const handler = tools[name]
      if (!handler) return null
      return {
        handler,
        schema: { type: 'object', properties: {} },
      }
    },
    list() {
      return Object.keys(tools).map((name) => ({
        name,
        description: `Mock tool: ${name}`,
        schema: { type: 'object', properties: {} },
      }))
    },
  }
}

async function collectEvents(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = []
  for await (const e of iterable) {
    events.push(e)
  }
  return events
}

const baseMessages: InternalMessage[] = [{ role: 'user', content: 'hello' }]

describe('AgentLoop', () => {
  it('1. no tool calls — emits turn_start → message_delta → turn_end → agent_end(no_tool_calls)', async () => {
    const chatFn = makeMockChatFn([{ content: 'Hello there!', tool_calls: [] }])
    const registry = makeMockRegistry({})
    const loop = new AgentLoop({ chatFn, toolRegistry: registry })

    const events = await collectEvents(loop.run({ messages: baseMessages, sessionId: 'sess1' }))

    expect(events[0]).toMatchObject({ type: 'turn_start', turn: 0 })
    expect(events[1]).toMatchObject({ type: 'message_delta', delta: 'Hello there!' })
    expect(events[2]).toMatchObject({ type: 'turn_end', toolCallCount: 0 })
    expect(events[3]).toMatchObject({ type: 'agent_end', stopReason: 'no_tool_calls', totalTurns: 1 })
    expect(events).toHaveLength(4)
  })

  it('2. single tool call — executes tool, calls LLM again, ends', async () => {
    const chatFn = makeMockChatFn([
      {
        content: 'Let me check',
        tool_calls: [{ id: 'tc1', name: 'search', args: { query: 'test' } }],
      },
      { content: 'Search result processed.', tool_calls: [] },
    ])
    const registry = makeMockRegistry({
      search: async () => ({ content: 'found it' }),
    })
    const loop = new AgentLoop({ chatFn, toolRegistry: registry })

    const events = await collectEvents(loop.run({ messages: baseMessages, sessionId: 'sess1' }))

    const types = events.map((e) => (e as { type: string }).type)
    expect(types).toContain('tool_start')
    expect(types).toContain('tool_end')
    expect(types.filter((t) => t === 'turn_start')).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', stopReason: 'no_tool_calls' })
  })

  it('3. multi-turn tool calls — two rounds of tools, then no_tool_calls', async () => {
    const chatFn = makeMockChatFn([
      { content: 'step1', tool_calls: [{ id: 'tc1', name: 'search', args: {} }] },
      { content: 'step2', tool_calls: [{ id: 'tc2', name: 'search', args: {} }] },
      { content: 'done', tool_calls: [] },
    ])
    const registry = makeMockRegistry({
      search: async () => ({ content: 'result' }),
    })
    const loop = new AgentLoop({ chatFn, toolRegistry: registry })

    const events = await collectEvents(loop.run({ messages: baseMessages, sessionId: 'sess1' }))

    const turnStarts = events.filter((e) => (e as { type: string }).type === 'turn_start')
    expect(turnStarts).toHaveLength(3)
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', stopReason: 'no_tool_calls', totalTurns: 3 })
  })

  it('4. maxTurns — agent_end(max_turns) when limit reached', async () => {
    const infiniteToolCalls: Array<{ content: string; tool_calls: ToolCall[] }> = Array(10).fill({
      content: 'still going',
      tool_calls: [{ id: 'tcX', name: 'search', args: {} }],
    })
    const chatFn = makeMockChatFn(infiniteToolCalls)
    const registry = makeMockRegistry({
      search: async () => ({ content: 'result' }),
    })
    const loop = new AgentLoop({ chatFn, toolRegistry: registry, config: { maxTurns: 2 } })

    const events = await collectEvents(loop.run({ messages: baseMessages, sessionId: 'sess1' }))

    expect(events.at(-1)).toMatchObject({ type: 'agent_end', stopReason: 'max_turns', totalTurns: 2 })
  })

  it('5. parallel tool execution — both tools are called', async () => {
    const callOrder: string[] = []
    const chatFn = makeMockChatFn([
      {
        content: 'using two tools',
        tool_calls: [
          { id: 'tc1', name: 'toolA', args: {} },
          { id: 'tc2', name: 'toolB', args: {} },
        ],
      },
      { content: 'done', tool_calls: [] },
    ])
    const registry = makeMockRegistry({
      toolA: async () => {
        callOrder.push('A')
        return { content: 'A result' }
      },
      toolB: async () => {
        callOrder.push('B')
        return { content: 'B result' }
      },
    })
    const loop = new AgentLoop({ chatFn, toolRegistry: registry, config: { toolExecutionMode: 'parallel' } })

    await collectEvents(loop.run({ messages: baseMessages, sessionId: 'sess1' }))

    expect(callOrder).toContain('A')
    expect(callOrder).toContain('B')
    expect(callOrder).toHaveLength(2)
  })

  it('6. sequential tool execution — tools in SEQUENTIAL_TOOLS run one by one', async () => {
    const callOrder: string[] = []
    const chatFn = makeMockChatFn([
      {
        content: 'writing files',
        tool_calls: [
          { id: 'tc1', name: 'write', args: {} },
          { id: 'tc2', name: 'edit', args: {} },
        ],
      },
      { content: 'done', tool_calls: [] },
    ])
    const registry = makeMockRegistry({
      write: async () => {
        callOrder.push('write')
        return { content: 'written' }
      },
      edit: async () => {
        callOrder.push('edit')
        return { content: 'edited' }
      },
    })
    const loop = new AgentLoop({ chatFn, toolRegistry: registry })

    await collectEvents(loop.run({ messages: baseMessages, sessionId: 'sess1' }))

    // Sequential tools must preserve order
    expect(callOrder).toEqual(['write', 'edit'])
  })

  it('7. beforeToolCall block — tool not executed, tool_end isError=true', async () => {
    const handlerCalled = vi.fn()
    const chatFn = makeMockChatFn([
      { content: 'doing stuff', tool_calls: [{ id: 'tc1', name: 'dangerous', args: {} }] },
      { content: 'okay fine', tool_calls: [] },
    ])
    const registry = makeMockRegistry({
      dangerous: async () => {
        handlerCalled()
        return { content: 'EXECUTED' }
      },
    })
    const loop = new AgentLoop({ chatFn, toolRegistry: registry })

    const events = await collectEvents(
      loop.run({
        messages: baseMessages,
        sessionId: 'sess1',
        beforeToolCall: async () => ({ block: true, reason: 'not allowed' }),
      }),
    )

    expect(handlerCalled).not.toHaveBeenCalled()
    const toolEnd = events.find((e) => (e as { type: string }).type === 'tool_end') as {
      type: string
      isError: boolean
      result: ToolResult
    }
    expect(toolEnd.isError).toBe(true)
    expect(toolEnd.result.content).toBe('not allowed')
  })

  it('8. afterToolCall override — returned value overrides original result', async () => {
    const chatFn = makeMockChatFn([
      { content: 'checking', tool_calls: [{ id: 'tc1', name: 'lookup', args: {} }] },
      { content: 'done', tool_calls: [] },
    ])
    const registry = makeMockRegistry({
      lookup: async () => ({ content: 'original result' }),
    })
    const loop = new AgentLoop({ chatFn, toolRegistry: registry })

    const events = await collectEvents(
      loop.run({
        messages: baseMessages,
        sessionId: 'sess1',
        afterToolCall: async () => ({ content: 'overridden result' }),
      }),
    )

    const toolEnd = events.find((e) => (e as { type: string }).type === 'tool_end') as {
      type: string
      result: ToolResult
    }
    expect(toolEnd.result.content).toBe('overridden result')
  })

  it('9. tool not found — tool_end isError=true', async () => {
    const chatFn = makeMockChatFn([
      { content: 'using unknown', tool_calls: [{ id: 'tc1', name: 'ghost', args: {} }] },
      { content: 'done', tool_calls: [] },
    ])
    const registry = makeMockRegistry({})
    const loop = new AgentLoop({ chatFn, toolRegistry: registry })

    const events = await collectEvents(loop.run({ messages: baseMessages, sessionId: 'sess1' }))

    const toolEnd = events.find((e) => (e as { type: string }).type === 'tool_end') as {
      type: string
      isError: boolean
      result: ToolResult
    }
    expect(toolEnd.isError).toBe(true)
    expect(toolEnd.result.content).toContain('ghost')
  })

  it('10. tool throws — tool_end isError=true with error message', async () => {
    const chatFn = makeMockChatFn([
      { content: 'running risky', tool_calls: [{ id: 'tc1', name: 'risky', args: {} }] },
      { content: 'done', tool_calls: [] },
    ])
    const registry = makeMockRegistry({
      risky: async () => {
        throw new Error('boom!')
      },
    })
    const loop = new AgentLoop({ chatFn, toolRegistry: registry })

    const events = await collectEvents(loop.run({ messages: baseMessages, sessionId: 'sess1' }))

    const toolEnd = events.find((e) => (e as { type: string }).type === 'tool_end') as {
      type: string
      isError: boolean
      result: ToolResult
    }
    expect(toolEnd.isError).toBe(true)
    expect(toolEnd.result.content).toBe('boom!')
  })

  it('11. AbortSignal — immediately yields agent_end(aborted)', async () => {
    const chatFn = makeMockChatFn([{ content: 'never', tool_calls: [] }])
    const registry = makeMockRegistry({})
    const loop = new AgentLoop({ chatFn, toolRegistry: registry })

    const controller = new AbortController()
    controller.abort()

    const events = await collectEvents(
      loop.run({ messages: baseMessages, sessionId: 'sess1', signal: controller.signal }),
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'agent_end', stopReason: 'aborted', totalTurns: 0 })
  })

  it('12. tool output truncated — content capped at maxToolOutputChars', async () => {
    const bigOutput = 'x'.repeat(200)
    const chatFn = makeMockChatFn([
      { content: 'fetch big', tool_calls: [{ id: 'tc1', name: 'bigTool', args: {} }] },
      { content: 'done', tool_calls: [] },
    ])
    const registry = makeMockRegistry({
      bigTool: async () => ({ content: bigOutput }),
    })
    const loop = new AgentLoop({
      chatFn,
      toolRegistry: registry,
      config: { maxToolOutputChars: 50 },
    })

    const events = await collectEvents(loop.run({ messages: baseMessages, sessionId: 'sess1' }))

    const toolEnd = events.find((e) => (e as { type: string }).type === 'tool_end') as {
      type: string
      result: ToolResult
    }
    expect(toolEnd.result.content.length).toBeLessThan(bigOutput.length)
    expect(toolEnd.result.content).toContain('[truncated')
  })
})

describe('high-confidence mode — clarify_uncertainty intercept', () => {
  const baseMessages: InternalMessage[] = [{ role: 'user', content: 'do something risky' }]

  it('pauses when agent calls clarify_uncertainty, resumes with user answers', async () => {
    // Turn 1: agent calls clarify_uncertainty
    // Turn 2 (after resume): agent finishes with no more tool calls
    const chatFn = makeMockChatFn([
      {
        content: 'Let me check first.',
        tool_calls: [{
          id: 'cu1',
          name: 'clarify_uncertainty',
          args: { items: [{ id: 'q1', question: 'Which env?', impact: 'blocking' }] },
        }],
      },
      { content: 'Got it, proceeding.', tool_calls: [] },
    ])

    const registry = makeMockRegistry({})
    const loop = new AgentLoop({
      chatFn,
      toolRegistry: registry,
      config: { uncertaintyCheck: { enabled: true } },
    })

    const events: unknown[] = []

    // Drain all events; when we see 'paused', immediately call resume() so
    // the generator can continue without deadlocking.
    for await (const event of loop.run({ messages: baseMessages, sessionId: 'hc-sess' })) {
      events.push(event)
      if ((event as { type: string }).type === 'paused') {
        const paused = event as { type: string; pauseId: string; payload: unknown }
        expect(paused.payload).toMatchObject({ kind: 'uncertainty_check' })
        // Resume synchronously inside the loop — generator will continue
        loop.resume(paused.pauseId, 'Use production env')
      }
    }

    const types = events.map((e) => (e as { type: string }).type)
    expect(types).toContain('paused')
    expect(types).toContain('tool_start')
    expect(types).toContain('tool_end')
    expect(types).toContain('agent_end')

    // tool_end for clarify_uncertainty should carry the user's answer
    const toolEnd = events.find(
      (e) => (e as { type: string; toolName?: string }).type === 'tool_end'
        && (e as { toolName: string }).toolName === 'clarify_uncertainty'
    ) as { result: ToolResult }
    expect(toolEnd.result.content).toBe('Use production env')
    expect(toolEnd.result.isError).toBe(false)
  }, 10000)

  it('does NOT intercept clarify_uncertainty when uncertaintyCheck is disabled', async () => {
    const chatFn = makeMockChatFn([
      {
        content: 'Checking.',
        tool_calls: [{
          id: 'cu2',
          name: 'clarify_uncertainty',
          args: { items: [{ id: 'q1', question: 'Confirm?', impact: 'optional' }] },
        }],
      },
      { content: 'Done.', tool_calls: [] },
    ])

    // Register clarify_uncertainty as a normal tool
    const registry = makeMockRegistry({
      clarify_uncertainty: async () => ({
        content: JSON.stringify({ status: 'pending_user_input', items: [] }),
        isError: false,
      }),
    })

    const loop = new AgentLoop({ chatFn, toolRegistry: registry })
    // uncertaintyCheck NOT enabled → no pause
    const events = await collectEvents(loop.run({ messages: baseMessages, sessionId: 'hc-sess2' }))

    const types = events.map((e) => (e as { type: string }).type)
    expect(types).not.toContain('paused')
    expect(types).toContain('agent_end')
  })
})
