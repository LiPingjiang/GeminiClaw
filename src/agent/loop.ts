import type { Message } from '../providers/types.js'
import type {
  AgentEvent,
  AgentConfig,
  ToolCall,
  ToolResult,
  BeforeToolCallContext,
  AfterToolCallContext,
} from './types.js'

// Internal message types supporting tool calls
type UserOrSystemMessage = { role: 'user' | 'system'; content: string }
type AssistantMessage = { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
type ToolMessage = { role: 'tool'; tool_call_id: string; content: string }

export type InternalMessage = UserOrSystemMessage | AssistantMessage | ToolMessage

export type ChatFn = (
  messages: InternalMessage[],
  options?: { model?: string; tools?: unknown[] }
) => Promise<{ content: string; tool_calls?: ToolCall[] }>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JSONSchema = Record<string, unknown>
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>

export interface ToolRegistryLike {
  get(name: string): { handler: ToolHandler; schema: JSONSchema; executionMode?: string } | null
  list(): Array<{ name: string; description: string; schema: JSONSchema; executionMode?: string }>
}

interface Logger {
  debug(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

const SEQUENTIAL_TOOLS = new Set(['exec', 'write', 'edit'])

interface ToolExecutionResult {
  toolCallId: string
  content: string
  isError: boolean
}

interface ExecuteToolsOutput {
  events: AgentEvent[]
  results: ToolExecutionResult[]
}

export class AgentLoop {
  private chatFn: ChatFn
  private toolRegistry: ToolRegistryLike
  private config: Required<AgentConfig>
  private logger: Logger

  constructor(params: {
    chatFn: ChatFn
    toolRegistry: ToolRegistryLike
    config?: AgentConfig
    logger?: Logger
  }) {
    this.chatFn = params.chatFn
    this.toolRegistry = params.toolRegistry
    this.config = {
      maxTurns: params.config?.maxTurns ?? 10,
      toolExecutionMode: params.config?.toolExecutionMode ?? 'parallel',
      maxToolOutputChars: params.config?.maxToolOutputChars ?? 8000,
      systemPrompt: params.config?.systemPrompt ?? '',
    }
    this.logger = params.logger ?? {
      debug: () => undefined,
      error: () => undefined,
    }
  }

  async *run(params: {
    messages: InternalMessage[]
    sessionId: string
    model?: string
    signal?: AbortSignal
    beforeToolCall?: (ctx: BeforeToolCallContext) => Promise<{ block?: boolean; reason?: string }>
    afterToolCall?: (ctx: AfterToolCallContext) => Promise<Partial<ToolResult> | undefined>
  }): AsyncIterable<AgentEvent> {
    let messages = [...params.messages]
    let turn = 0
    const maxTurns = this.config.maxTurns

    while (turn < maxTurns) {
      if (params.signal?.aborted) {
        yield { type: 'agent_end', totalTurns: turn, stopReason: 'aborted' }
        return
      }

      yield { type: 'turn_start', turn }
      turn++

      const toolSchemas = this.toolRegistry.list().map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
      }))

      let response: { content: string; tool_calls?: ToolCall[] }
      try {
        response = await this.chatFn(messages, {
          model: params.model,
          tools: toolSchemas,
        })
      } catch (err) {
        this.logger.error('chatFn threw', err)
        yield { type: 'agent_end', totalTurns: turn, stopReason: 'aborted' }
        return
      }

      if (response.content) {
        yield { type: 'message_delta', delta: response.content }
      }

      const assistantMsg: AssistantMessage = {
        role: 'assistant',
        content: response.content,
        tool_calls: response.tool_calls,
      }
      messages = [...messages, assistantMsg]

      yield {
        type: 'turn_end',
        message: { role: 'assistant', content: response.content } satisfies Message,
        toolCallCount: response.tool_calls?.length ?? 0,
      }

      if (!response.tool_calls || response.tool_calls.length === 0) {
        yield { type: 'agent_end', totalTurns: turn, stopReason: 'no_tool_calls' }
        return
      }

      const { events, results } = await this.executeTools(
        response.tool_calls,
        params.sessionId,
        params.beforeToolCall,
        params.afterToolCall,
      )

      for (const event of events) {
        yield event
      }

      for (const tr of results) {
        messages = [
          ...messages,
          { role: 'tool', tool_call_id: tr.toolCallId, content: tr.content } satisfies ToolMessage,
        ]
      }
    }

    yield { type: 'agent_end', totalTurns: turn, stopReason: 'max_turns' }
  }

  private shouldParallelize(toolCalls: ToolCall[]): boolean {
    if (this.config.toolExecutionMode === 'sequential') return false
    return toolCalls.every((tc) => !SEQUENTIAL_TOOLS.has(tc.name))
  }

  private truncate(content: string): string {
    const max = this.config.maxToolOutputChars
    if (content.length <= max) return content
    return content.slice(0, max) + `...[truncated ${content.length - max} chars]`
  }

  private async executeSingleTool(
    tc: ToolCall,
    sessionId: string,
    beforeToolCall?: (ctx: BeforeToolCallContext) => Promise<{ block?: boolean; reason?: string }>,
    afterToolCall?: (ctx: AfterToolCallContext) => Promise<Partial<ToolResult> | undefined>,
  ): Promise<{ events: AgentEvent[]; result: ToolExecutionResult }> {
    const events: AgentEvent[] = []

    events.push({
      type: 'tool_start',
      toolCallId: tc.id,
      toolName: tc.name,
      args: tc.args,
    })

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
        const result: ToolResult = {
          content: decision.reason ?? `Tool ${tc.name} was blocked`,
          isError: true,
        }
        events.push({
          type: 'tool_end',
          toolCallId: tc.id,
          toolName: tc.name,
          result,
          isError: true,
          durationMs: 0,
        })
        return {
          events,
          result: { toolCallId: tc.id, content: result.content, isError: true },
        }
      }
    }

    const entry = this.toolRegistry.get(tc.name)
    if (!entry) {
      const result: ToolResult = {
        content: `Tool not found: ${tc.name}`,
        isError: true,
      }
      events.push({
        type: 'tool_end',
        toolCallId: tc.id,
        toolName: tc.name,
        result,
        isError: true,
        durationMs: 0,
      })
      return {
        events,
        result: { toolCallId: tc.id, content: result.content, isError: true },
      }
    }

    const startMs = Date.now()
    let toolResult: ToolResult
    let isError = false

    try {
      toolResult = await entry.handler(tc.args)
      isError = toolResult.isError ?? false
    } catch (err) {
      isError = true
      toolResult = {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      }
    }

    const durationMs = Date.now() - startMs
    toolResult = { ...toolResult, content: this.truncate(toolResult.content) }

    // afterToolCall hook
    if (afterToolCall) {
      const ctx: AfterToolCallContext = {
        toolCallId: tc.id,
        toolName: tc.name,
        args: tc.args,
        result: toolResult,
        durationMs,
        sessionId,
      }
      const override = await afterToolCall(ctx)
      if (override !== undefined) {
        toolResult = { ...toolResult, ...override }
        if (override.isError !== undefined) isError = override.isError
      }
    }

    events.push({
      type: 'tool_end',
      toolCallId: tc.id,
      toolName: tc.name,
      result: toolResult,
      isError,
      durationMs,
    })

    return {
      events,
      result: { toolCallId: tc.id, content: toolResult.content, isError },
    }
  }

  private async executeTools(
    toolCalls: ToolCall[],
    sessionId: string,
    beforeToolCall?: (ctx: BeforeToolCallContext) => Promise<{ block?: boolean; reason?: string }>,
    afterToolCall?: (ctx: AfterToolCallContext) => Promise<Partial<ToolResult> | undefined>,
  ): Promise<ExecuteToolsOutput> {
    const allEvents: AgentEvent[] = []
    const allResults: ToolExecutionResult[] = []

    if (this.shouldParallelize(toolCalls)) {
      const outputs = await Promise.all(
        toolCalls.map((tc) => this.executeSingleTool(tc, sessionId, beforeToolCall, afterToolCall)),
      )
      for (const out of outputs) {
        allEvents.push(...out.events)
        allResults.push(out.result)
      }
    } else {
      for (const tc of toolCalls) {
        const out = await this.executeSingleTool(tc, sessionId, beforeToolCall, afterToolCall)
        allEvents.push(...out.events)
        allResults.push(out.result)
      }
    }

    return { events: allEvents, results: allResults }
  }
}
