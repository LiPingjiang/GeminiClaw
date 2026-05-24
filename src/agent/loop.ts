import { randomUUID } from 'crypto'
import type { Message } from '../providers/types.js'
import type {
  AgentEvent,
  AgentConfig,
  ToolCall,
  ToolResult,
  BeforeToolCallContext,
  AfterToolCallContext,
  PausePayload,
} from './types.js'
import { GuardrailController } from './guardrails.js'

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

interface ToolContext {
  sessionId: string
  workdir: string
  logger: {
    info(msg: string, ...args: unknown[]): void
    warn(msg: string, ...args: unknown[]): void
    error(msg: string, ...args: unknown[]): void
  }
  extra?: Record<string, unknown>
}

type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>

export interface ToolRegistryLike {
  get(name: string): { handler: ToolHandler; schema: JSONSchema; executionMode?: string } | null
  list(): Array<{ name: string; description: string; schema: JSONSchema; executionMode?: string }>
}

interface Logger {
  debug(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
  info?(msg: string, ...args: unknown[]): void
  warn?(msg: string, ...args: unknown[]): void
}

const SEQUENTIAL_TOOLS = new Set(['exec', 'write', 'edit'])

// Tools that mutate state — used by high-confidence mode beforeToolCall check
const MUTATING_TOOLS = new Set(['exec', 'write', 'edit', 'file_write'])

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
  private config: Required<Pick<AgentConfig, 'maxTurns' | 'toolExecutionMode' | 'maxToolOutputChars' | 'systemPrompt'>> & Omit<AgentConfig, 'maxTurns' | 'toolExecutionMode' | 'maxToolOutputChars' | 'systemPrompt'>
  private logger: Logger

  // ── Interrupt point state ──────────────────────────────────────────────────
  private pauseId: string | null = null
  private pauseResolve: ((input: unknown) => void) | null = null
  private uncertaintyCleared = false  // set after first clarify_uncertainty is answered
  private _toolContextExtra: Record<string, unknown> = {}

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
      maxToolCallsPerTurn: params.config?.maxToolCallsPerTurn,
      guardrails: params.config?.guardrails,
      planning: params.config?.planning,
      uncertaintyCheck: params.config?.uncertaintyCheck,
    }
    this.logger = params.logger ?? {
      debug: () => undefined,
      error: () => undefined,
    }
  }

  // ── Public: resume after pause ─────────────────────────────────────────────

  /**
   * Resume a paused loop. Called externally (e.g., from the HTTP route handler)
   * after the user confirms a plan or answers uncertainty questions.
   */
  resume(pauseId: string, userInput: unknown): boolean {
    if (this.pauseId !== pauseId || !this.pauseResolve) {
      return false
    }
    this.pauseResolve(userInput)
    this.pauseResolve = null
    this.pauseId = null
    return true
  }

  get isPaused(): boolean {
    return this.pauseResolve !== null
  }

  get currentPauseId(): string | null {
    return this.pauseId
  }

  // ── Main run loop ──────────────────────────────────────────────────────────

  async *run(params: {
    messages: InternalMessage[]
    sessionId: string
    model?: string
    signal?: AbortSignal
    beforeToolCall?: (ctx: BeforeToolCallContext) => Promise<{ block?: boolean; reason?: string }>
    afterToolCall?: (ctx: AfterToolCallContext) => Promise<Partial<ToolResult> | undefined>
    /** Extra per-invocation context passed through to tool handlers (e.g. db, userId). */
    toolContextExtra?: Record<string, unknown>
  }): AsyncIterable<AgentEvent> {
    // Reset per-run state
    this.uncertaintyCleared = false
    this._toolContextExtra = params.toolContextExtra ?? {}

    let messages = [...params.messages]
    let turn = 0
    const maxTurns = this.config.maxTurns

    // ── Command handling ────────────────────────────────────────────────────
    // 检查最新消息是否为命令
    const lastMessage = messages[messages.length - 1]
    if (lastMessage && lastMessage.role === 'user') {
      const { CommandParser } = await import('./command-parser.js')
      
      if (CommandParser.isCommand(lastMessage.content)) {
        const commandArgs = CommandParser.toToolCallArgs(lastMessage.content)
        if (commandArgs) {
          // 调用 evolution_command 工具
          const toolEntry = this.toolRegistry.get('evolution_command')
          if (toolEntry) {
            try {
              const result = await toolEntry.handler(commandArgs, {
                sessionId: params.sessionId,
                workdir: process.cwd(),
                logger: {
                  info: this.logger.info?.bind(this.logger) || (() => undefined),
                  warn: this.logger.warn?.bind(this.logger) || (() => undefined),
                  error: this.logger.error.bind(this.logger),
                },
              })
              
              // 直接返回工具结果作为响应
              const toolRes = result as unknown as { type?: string; text?: string; error?: string; content?: string }
              const resultText = toolRes.type === 'text' ? (toolRes.text ?? '命令执行失败')
                : toolRes.type === 'error' ? `❌ ${toolRes.error}`
                : (toolRes.content ?? '命令执行失败')
              yield { type: 'message_delta', delta: resultText }
              yield { type: 'agent_end', totalTurns: 1, stopReason: 'no_tool_calls' }
              return
            } catch (err) {
              yield { type: 'message_delta', delta: `❌ 命令执行失败: ${err}` }
              yield { type: 'agent_end', totalTurns: 1, stopReason: 'aborted' }
              return
            }
          }
        }
      }
    }

    // Guardrails — only active when config.guardrails is set
    const guardrails = this.config.guardrails
      ? new GuardrailController(this.config.guardrails)
      : null

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

      // ── Plan mode: detect <plan>...</plan> and pause ─────────────────────
      if (this.config.planning?.enabled && response.content) {
        const planResult = this.extractPlan(response.content)
        if (planResult) {
          const assistantMsg: AssistantMessage = {
            role: 'assistant',
            content: response.content,
          }
          messages = [...messages, assistantMsg]

          yield {
            type: 'turn_end',
            message: { role: 'assistant', content: response.content } satisfies Message,
            toolCallCount: 0,
          }

          // Pause and wait for user confirmation
          const userInput = yield* this.doPause({
            kind: 'plan_ready',
            data: { plan: planResult },
          })

          // Inject confirmation into context and continue
          const confirmMsg = typeof userInput === 'string' && userInput.trim()
            ? userInput
            : 'Plan confirmed. Please proceed with execution.'
          messages = [
            ...messages,
            { role: 'user', content: confirmMsg } satisfies UserOrSystemMessage,
          ]
          continue
        }
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

      // ── Step mode: limit tool calls per turn ─────────────────────────────
      const toolCallsToRun = this.config.maxToolCallsPerTurn
        ? response.tool_calls.slice(0, this.config.maxToolCallsPerTurn)
        : response.tool_calls

      // ── High-confidence mode: intercept clarify_uncertainty tool call ────
      // When the agent calls clarify_uncertainty, we pause the loop here
      // (before executeTools) so the route layer can stream the paused event
      // and wait for user answers via /v1/agent/resume.
      if (this.config.uncertaintyCheck?.enabled && !this.uncertaintyCleared) {
        const clarifyIdx = toolCallsToRun.findIndex(tc => tc.name === 'clarify_uncertainty')
        if (clarifyIdx !== -1) {
          const clarifyTc = toolCallsToRun[clarifyIdx]

          // Emit tool_start so the client knows the tool was invoked
          yield { type: 'tool_start', toolCallId: clarifyTc.id, toolName: clarifyTc.name, args: clarifyTc.args }

          // Pause and wait for user to answer the uncertainty questions
          const userAnswers = yield* this.doPause({
            kind: 'uncertainty_check',
            data: { items: clarifyTc.args['items'] ?? [] },
          })

          // Build a synthetic tool result containing the user's answers,
          // and inject it into messages so the loop can continue
          let answersText: string
          if (typeof userAnswers === 'string' && userAnswers.trim()) {
            answersText = userAnswers
          } else if (userAnswers && typeof userAnswers === 'object') {
            // {answers: {id: text}, skipAll: bool} from resume route
            const obj = userAnswers as Record<string, unknown>
            if (obj.skipAll) {
              answersText = '[User chose to skip all questions — proceed with best judgment]'
            } else if (obj.answers && typeof obj.answers === 'object') {
              const ans = obj.answers as Record<string, string>
              const lines = Object.entries(ans)
                .filter(([, v]) => v && String(v).trim())
                .map(([k, v]) => `- ${k}: ${v}`)
              answersText = lines.length > 0
                ? `User provided answers:\n${lines.join('\n')}`
                : '[User confirmed: proceed with best judgment]'
            } else {
              answersText = `[User input: ${JSON.stringify(userAnswers)}]`
            }
          } else {
            answersText = '[User confirmed: proceed with best judgment]'
          }

          yield {
            type: 'tool_end',
            toolCallId: clarifyTc.id,
            toolName: clarifyTc.name,
            result: { content: answersText, isError: false },
            isError: false,
            durationMs: 0,
          }

          // Inject assistant message (with tool_calls) + tool result into context
          messages = [
            ...messages,
            {
              role: 'assistant' as const,
              content: response.content,
              tool_calls: response.tool_calls,
            },
            {
              role: 'tool' as const,
              tool_call_id: clarifyTc.id,
              content: answersText,
            },
          ]

          // Mark uncertainties as cleared so subsequent clarify_uncertainty calls
          // are not intercepted again (model may call it again after seeing answers)
          this.uncertaintyCleared = true

          // Skip normal executeTools for this turn — continue to next LLM turn
          continue
        }
      }

      const { events, results } = await this.executeTools(
        toolCallsToRun,
        params.sessionId,
        params.beforeToolCall,
        params.afterToolCall,
      )

      for (const event of events) {
        yield event
      }

      // ── Guardrails: check results ─────────────────────────────────────────
      if (guardrails) {
        let anySuccess = false
        let shouldHalt = false

        for (const result of results) {
          const toolName = toolCallsToRun.find(tc => tc.id === result.toolCallId)?.name ?? 'unknown'
          const decision = guardrails.record(toolName, result.isError)

          if (decision.action === 'warn') {
            yield { type: 'guardrail_warn', toolName, message: decision.message }
          } else if (decision.action === 'halt') {
            yield { type: 'guardrail_halt', toolName, message: decision.message }
            shouldHalt = true
            break
          }

          if (!result.isError) anySuccess = true
        }

        if (shouldHalt) {
          yield { type: 'agent_end', totalTurns: turn, stopReason: 'aborted' }
          return
        }

        // Any tool call (success or failure) counts as progress.
        // "No progress" means the model produced no tool calls at all
        // (stuck in a loop of pure text output).
        const anyToolCalled = results.length > 0
        if (anyToolCalled) {
          guardrails.recordProgress()
        } else if (!anySuccess) {
          const noProgressDecision = guardrails.recordNoProgress()
          if (noProgressDecision.action === 'warn') {
            yield { type: 'guardrail_warn', toolName: '', message: noProgressDecision.message }
          } else if (noProgressDecision.action === 'halt') {
            yield { type: 'guardrail_halt', toolName: '', message: noProgressDecision.message }
            yield { type: 'agent_end', totalTurns: turn, stopReason: 'aborted' }
            return
          }
        }
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

  // ── Interrupt point implementation ────────────────────────────────────────

  /**
   * Yields a 'paused' event and waits until resume() is called.
   * This is a generator method so it can yield into the parent run() generator.
   */
  private async *doPause(payload: PausePayload): AsyncGenerator<AgentEvent, unknown, undefined> {
    const pauseId = randomUUID()
    this.pauseId = pauseId

    // Set up the promise BEFORE yielding, so resume() can call it
    // even if called synchronously inside the consumer's for-await loop body.
    const waitForResume = new Promise<unknown>((resolve) => {
      this.pauseResolve = resolve
    })

    yield { type: 'paused', pauseId, payload }

    // Wait for resume() to be called externally
    const userInput = await waitForResume

    return userInput
  }

  // ── Plan extraction ───────────────────────────────────────────────────────

  private extractPlan(content: string): unknown[] | null {
    const match = content.match(/<plan>([\s\S]*?)<\/plan>/)
    if (!match) return null
    try {
      const parsed = JSON.parse(match[1].trim())
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    } catch {
      // not valid JSON, ignore
    }
    return null
  }

  // ── Tool execution ────────────────────────────────────────────────────────

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

    // ── High-confidence mode: block mutating tools until uncertainties cleared ──
    if (
      this.config.uncertaintyCheck?.enabled &&
      MUTATING_TOOLS.has(tc.name)
    ) {
      // The beforeToolCall hook (provided by the route layer) handles the
      // actual session-state check. Here we just ensure it's always called.
      // If no hook is provided, we block by default in high-confidence mode.
      if (!beforeToolCall) {
        const result: ToolResult = {
          content: `[high-confidence mode] Cannot run "${tc.name}" before uncertainties are resolved. Please answer the clarifying questions first.`,
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
      const toolContext: ToolContext = {
        sessionId,
        workdir: process.cwd(),
        logger: {
          info: this.logger.info?.bind(this.logger) || (() => undefined),
          warn: this.logger.warn?.bind(this.logger) || (() => undefined),
          error: this.logger.error.bind(this.logger),
        },
        extra: this._toolContextExtra,
      }
      toolResult = await entry.handler(tc.args, toolContext)
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
