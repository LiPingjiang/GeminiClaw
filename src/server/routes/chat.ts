// src/server/routes/chat.ts
import type { FastifyInstance } from "fastify"
import type { ProviderRouter } from "../../providers/router.js"
import type { MemoryStrategy } from "../../memory/strategy.js"
import type { EvolutionEngine } from "../../evolution/index.js"
import type { AgentLoop, InternalMessage } from "../../agent/index.js"
import type { SessionStore } from "../../session/store.js"
import type { AgentMode, AgentConfig } from "../../agent/types.js"

// ── Mode helpers ──────────────────────────────────────────────────────────────

const VALID_MODES: AgentMode[] = ['auto', 'step', 'plan', 'high-confidence']
const MODE_ALIASES: Record<string, AgentMode> = { hc: 'high-confidence', 'high_confidence': 'high-confidence' }

function parseMode(raw: string): AgentMode | null {
  const normalized = raw.trim().toLowerCase() as AgentMode
  if (VALID_MODES.includes(normalized)) return normalized
  return MODE_ALIASES[normalized] ?? null
}

function buildAgentConfig(mode: AgentMode, base?: Partial<AgentConfig>): AgentConfig {
  const config: AgentConfig = { ...base }
  switch (mode) {
    case 'step':
      config.maxToolCallsPerTurn = 1
      config.guardrails = config.guardrails ?? {}
      break
    case 'plan':
      config.planning = { enabled: true }
      config.guardrails = config.guardrails ?? {}
      break
    case 'high-confidence':
      config.uncertaintyCheck = { enabled: true }
      config.guardrails = config.guardrails ?? {}
      config.systemPrompt = [
        'You are operating in HIGH-CONFIDENCE mode.',
        'Before taking ANY action that could modify files, execute code, or cause side effects,',
        'you MUST first call the `clarify_uncertainty` tool to surface all things you are uncertain about.',
        'List every ambiguity as a separate item. Mark items as "blocking" if you cannot proceed without an answer.',
        'Only after the user answers your questions may you proceed with execution.',
        'If the user\'s request is purely informational (reading, explaining, answering questions) you may respond directly without calling clarify_uncertainty.',
      ].join(' ')
      break
    case 'auto':
    default:
      break
  }
  return config
}

const MODE_LABELS: Record<AgentMode, string> = {
  auto: '🤖 Auto（全自主，默认）',
  step: '👣 Step（一步一观察）',
  plan: '📋 Plan（先规划后执行）',
  'high-confidence': '🔒 高置信度（先消除不确定性）',
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChatBody {
  message: string
  sessionId?: string
  model?: string
  stream?: boolean
  mode?: string  // per-request mode override
}

interface ResumeBody {
  sessionId: string
  pauseId: string
  input?: string
}

interface ChatRouteOpts {
  router: ProviderRouter
  strategy: MemoryStrategy
  authToken?: string
  evolution?: EvolutionEngine
  agentLoop?: AgentLoop
  sessionStore?: SessionStore
}

// ── Active paused loops (in-memory, per process) ──────────────────────────────
// Maps sessionId → { loop, pauseKind } for the currently paused agent
interface PausedEntry {
  loop: AgentLoop
  pauseKind?: string  // 'plan_ready' | 'uncertainty_check'
  iter?: AsyncIterator<import('../../agent/types.js').AgentEvent>  // remaining generator after pause
}
const pausedLoops = new Map<string, PausedEntry>()

// ── Trace helper ──────────────────────────────────────────────────────────────

function recordTrace(
  evolution: EvolutionEngine | undefined,
  sessionId: string,
  hadFailure: boolean,
  messageCount: number,
  toolSequence: string[] = [],
  responseLength = 0,
  userMessage?: string,
  agentReply?: string,
): void {
  if (!evolution) return
  setImmediate(() => {
    evolution.getTraceCollector().record({
      sessionId,
      toolSequence,
      hadFailure,
      messageCount,
      responseLength,
    })
    evolution.onTraceRecorded()
    // Save conversation content for PreviewService
    if (userMessage && agentReply) {
      evolution.getConversationStore().save({
        sessionId,
        userMessage,
        agentReply,
        toolSequence,
        hadFailure,
      })
    }
  })
}

// ── Route registration ────────────────────────────────────────────────────────

export async function chatRoute(
  fastify: FastifyInstance,
  opts: ChatRouteOpts,
): Promise<void> {

  // ── /mode command helper ───────────────────────────────────────────────────

  function handleModeCommand(sessionId: string, text: string): string | null {
    if (!opts.sessionStore) return null
    const trimmed = text.trim()
    if (!trimmed.startsWith('/mode')) return null

    const parts = trimmed.split(/\s+/)
    if (parts.length === 1) {
      // /mode → show current
      const current = (opts.sessionStore.getMeta(sessionId, 'agent_mode') ?? 'auto') as AgentMode
      return `当前模式：${MODE_LABELS[current]}\n\n可用模式：\n${VALID_MODES.map(m => `• /mode ${m === 'high-confidence' ? 'hc' : m}  →  ${MODE_LABELS[m]}`).join('\n')}`
    }

    const modeArg = parts[1]
    const mode = parseMode(modeArg)
    if (!mode) {
      return `未知模式：${modeArg}\n可用：auto / step / plan / hc（高置信度）`
    }

    opts.sessionStore.setMeta(sessionId, 'agent_mode', mode)
    return `✅ 已切换到 ${MODE_LABELS[mode]}`
  }

  // ── POST /v1/agent/chat ────────────────────────────────────────────────────

  fastify.post<{ Body: ChatBody }>("/v1/agent/chat", async (request, reply) => {
    if (opts.authToken) {
      const auth = request.headers["authorization"]
      if (!auth || auth !== `Bearer ${opts.authToken}`) {
        return reply.status(401).send({ error: "Unauthorized" })
      }
    }

    const { message, sessionId, model, stream: wantStream, mode: requestMode } = request.body

    if (!message || typeof message !== "string" || message.trim() === "") {
      return reply.status(400).send({ error: "message is required and must be a non-empty string" })
    }

    const sid = sessionId ?? crypto.randomUUID()
    await opts.strategy.ensureSession(sid)

    // ── /mode command intercept ──────────────────────────────────────────────
    const modeResponse = handleModeCommand(sid, message)
    if (modeResponse !== null) {
      return reply.send({ response: modeResponse, sessionId: sid })
    }

      // ── Evolution ritual intent check ──────────────────────────────────────
      if (opts.evolution) {
        const classifier = opts.evolution.getIntentClassifier()
        const ritualHandler = opts.evolution.getRitualHandler()
        const classified = await classifier.classify(message)

        if (classified.intent === "evolve") {
          const ritualReply = ritualHandler.listCandidates(sid)
          return reply.send({ response: ritualReply, sessionId: sid, totalTurns: 0, toolsUsed: [] })
        }

        if (classified.intent === "evolve_show" && classified.index !== undefined) {
          const ritualReply = ritualHandler.showPreview(sid, classified.index)
          return reply.send({ response: ritualReply, sessionId: sid, totalTurns: 0, toolsUsed: [] })
        }

        if (classified.intent === "evolve_confirm") {
          const intentId = ritualHandler.getSelectedIntentId(sid)
          if (!intentId) {
            return reply.send({ response: '请先说"看第N个"选择一个优化项，再确认应用。', sessionId: sid, totalTurns: 0, toolsUsed: [] })
          }
          try {
            await opts.evolution.approveIntent(intentId, "user-chat")
            ritualHandler.clearState(sid)
            return reply.send({ response: "✅ 优化已应用！Evolution Engine 正在切换到新版本。", sessionId: sid, totalTurns: 0, toolsUsed: [] })
          } catch (err) {
            return reply.send({ response: `应用失败：${(err as Error).message}`, sessionId: sid, totalTurns: 0, toolsUsed: [] })
          }
        }

        if (classified.intent === "evolve_reject") {
          ritualHandler.clearState(sid)
          return reply.send({ response: "好的，已退出进化仪式。继续正常对话。", sessionId: sid, totalTurns: 0, toolsUsed: [] })
        }
        // classified.intent === "chat" → fall through to normal handling
      }

    // ── Resolve session mode ─────────────────────────────────────────────────
    let activeMode: AgentMode = 'auto'
    if (requestMode) {
      activeMode = parseMode(requestMode) ?? 'auto'
    } else if (opts.sessionStore) {
      activeMode = (opts.sessionStore.getMeta(sid, 'agent_mode') ?? 'auto') as AgentMode
    }

    const { messages: contextMessages } = await opts.strategy.getContext(sid, message)
    const allMessages = [...contextMessages, { role: "user" as const, content: message }]

    // ── AgentLoop path ───────────────────────────────────────────────────────
    if (opts.agentLoop) {
      // Build config for this mode
      const agentConfig = buildAgentConfig(activeMode)

      // Inject agentConfig into the loop (create a fresh loop with config if needed,
      // or pass via run() params — for now we patch the config directly)
      // TODO: refactor AgentLoop to accept per-run config override
      Object.assign((opts.agentLoop as unknown as { config: AgentConfig }).config ?? {}, agentConfig)

      const internalMessages: InternalMessage[] = allMessages.map(m => ({
        role: m.role as "user" | "assistant" | "system",
        // InternalMessage.content is always string; flatten multimodal to text-only
        content: typeof m.content === "string"
          ? m.content
          : m.content.filter(p => p.type === "text").map(p => p.type === "text" ? p.text : "").join("\n"),
      }))

      // High-confidence mode: beforeToolCall hook checks uncertainty_cleared
      const beforeToolCall = activeMode === 'high-confidence' && opts.sessionStore
        ? async (ctx: import("../../agent/types.js").BeforeToolCallContext) => {
            const MUTATING = new Set(['exec', 'write', 'edit', 'file_write'])
            if (!MUTATING.has(ctx.toolName)) return {}
            const cleared = opts.sessionStore!.getMeta(sid, 'uncertainty_cleared')
            if (cleared !== 'true') {
              return {
                block: true,
                reason: `[高置信度模式] 执行 "${ctx.toolName}" 前需先回答所有关键问题。请先用 clarify_uncertainty 工具列出不确定点。`,
              }
            }
            return {}
          }
        : undefined

      if (wantStream) {
        reply.hijack()
        const raw = reply.raw
        raw.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        })

        let fullContent = ""
        const toolSequence: string[] = []
        let hadFailure = false

        const loop = opts.agentLoop
        const runIter = loop.run({
          messages: internalMessages,
          sessionId: sid,
          model,
          beforeToolCall,
        })

        for await (const event of runIter) {
          switch (event.type) {
            case "message_delta":
              fullContent += event.delta
              raw.write(`data: ${JSON.stringify({ choices: [{ delta: { content: event.delta } }] })}\n\n`)
              break
            case "tool_start":
              toolSequence.push(event.toolName)
              raw.write(`data: ${JSON.stringify({ type: "tool_start", toolName: event.toolName })}\n\n`)
              break
            case "tool_end":
              if (event.isError) hadFailure = true
              raw.write(`data: ${JSON.stringify({ type: "tool_end", toolName: event.toolName, isError: event.isError })}\n\n`)
              break
            case "paused":
              // Store loop reference + pause kind so resume can find it
              pausedLoops.set(sid, { loop, pauseKind: (event.payload as { kind?: string })?.kind })
              raw.write(`data: ${JSON.stringify({ type: "paused", pauseId: event.pauseId, payload: event.payload })}\n\n`)
              // SSE stays open — client will call /v1/agent/resume
              break
            case "guardrail_warn":
              raw.write(`data: ${JSON.stringify({ type: "guardrail_warn", message: event.message })}\n\n`)
              break
            case "guardrail_halt":
              raw.write(`data: ${JSON.stringify({ type: "guardrail_halt", message: event.message })}\n\n`)
              break
            case "agent_end":
              pausedLoops.delete(sid)
              raw.write(`data: ${JSON.stringify({ type: "done", mode: activeMode })}\n\n`)
              raw.write("data: [DONE]\n\n")
              break
          }
        }

        raw.end()

        if (fullContent) {
          await opts.strategy.appendTurn(
            sid,
            { role: "user", content: message },
            { role: "assistant", content: fullContent },
          )
        }
        recordTrace(opts.evolution, sid, hadFailure, allMessages.length + 1, toolSequence, fullContent.length, message, fullContent)
        return
      }

      // AgentLoop 非流式
      let finalContent = ""
      const toolSequence: string[] = []
      let hadFailure = false
      let totalTurns = 0
      let pauseInfo: { pauseId: string; payload: unknown } | null = null

      const runIter = opts.agentLoop.run({
        messages: internalMessages,
        sessionId: sid,
        model,
        beforeToolCall,
      })[Symbol.asyncIterator]()

      outer: while (true) {
        const { value: event, done } = await runIter.next()
        if (done) break
        switch (event.type) {
          case "message_delta":
            finalContent += event.delta
            break
          case "tool_start":
            toolSequence.push(event.toolName)
            break
          case "tool_end":
            if (event.isError) hadFailure = true
            break
          case "paused":
            // Non-streaming path: store loop + iterator and break immediately.
            // The client must call /v1/agent/resume to continue.
            pausedLoops.set(sid, { loop: opts.agentLoop, pauseKind: (event.payload as { kind?: string })?.kind, iter: runIter })
            pauseInfo = { pauseId: event.pauseId, payload: event.payload }
            break outer  // exit while loop immediately; return paused response below
          case "agent_end":
            pausedLoops.delete(sid)
            totalTurns = event.totalTurns
            break outer
        }
      }

      await opts.strategy.appendTurn(
        sid,
        { role: "user", content: message },
        { role: "assistant", content: finalContent },
      )
      recordTrace(opts.evolution, sid, hadFailure, allMessages.length + 1, toolSequence, finalContent.length, message, finalContent)

      return reply.send({
        response: finalContent,
        sessionId: sid,
        totalTurns,
        toolsUsed: toolSequence,
        mode: activeMode,
        ...(pauseInfo ? { paused: pauseInfo } : {}),
      })
    }

    // ── Legacy single-shot path (no AgentLoop) ───────────────────────────────
    if (wantStream) {
      reply.hijack()
      const raw = reply.raw
      raw.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      })

      let fullContent = ""
      let streamFailed = false

      try {
        for await (const chunk of opts.router.stream(allMessages, model ? { model } : undefined)) {
          if (chunk.delta) {
            fullContent += chunk.delta
            raw.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk.delta } }] })}\n\n`)
          }
          if (chunk.done) {
            raw.write(`data: ${JSON.stringify({ type: "done" })}\n\n`)
            raw.write("data: [DONE]\n\n")
          }
        }
      } catch (err) {
        streamFailed = true
        raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`)
      } finally {
        raw.end()
      }

      if (fullContent) {
        await opts.strategy.appendTurn(
          sid,
          { role: "user", content: message },
          { role: "assistant", content: fullContent },
        )
      }
      recordTrace(opts.evolution, sid, streamFailed, allMessages.length + 1, [], fullContent.length, message, fullContent)
      return
    }

    let chatFailed = false
    let chatResponse
    try {
      chatResponse = await opts.router.chat(allMessages, model ? { model } : undefined)
    } catch (err) {
      chatFailed = true
      recordTrace(opts.evolution, sid, true, allMessages.length + 1)
      return reply.status(500).send({ error: String(err) })
    }

    await opts.strategy.appendTurn(
      sid,
      { role: "user", content: message },
      { role: "assistant", content: chatResponse.content },
    )
    recordTrace(opts.evolution, sid, chatFailed, allMessages.length + 1, [], 0, message, chatResponse.content)

    return reply.send({
      response: chatResponse.content,
      sessionId: sid,
      model: chatResponse.model,
    })
  })

  // ── POST /v1/agent/resume ──────────────────────────────────────────────────

  fastify.post<{ Body: ResumeBody }>("/v1/agent/resume", async (request, reply) => {
    if (opts.authToken) {
      const auth = request.headers["authorization"]
      if (!auth || auth !== `Bearer ${opts.authToken}`) {
        return reply.status(401).send({ error: "Unauthorized" })
      }
    }

    const { sessionId, pauseId, input } = request.body
    if (!sessionId || !pauseId) {
      return reply.status(400).send({ error: "sessionId and pauseId are required" })
    }

    const entry = pausedLoops.get(sessionId)
    if (!entry) {
      return reply.status(404).send({ error: "No paused loop found for this session" })
    }

    // If this was an uncertainty_check pause, mark uncertainties as cleared
    // so the beforeToolCall hook will allow mutating tools to proceed
    if (entry.pauseKind === 'uncertainty_check' && opts.sessionStore) {
      opts.sessionStore.setMeta(sessionId, 'uncertainty_cleared', 'true')
    }

    const ok = entry.loop.resume(pauseId, input ?? '')
    if (!ok) {
      return reply.status(409).send({ error: "pauseId mismatch or loop is not paused" })
    }

    // Wait for the resumed loop to finish (or pause again), collecting events
    let finalContent = ''
    let totalTurns = 0
    const toolSequence: string[] = []
    let nextPauseInfo: { pauseId: string; payload: unknown } | null = null

    // The loop's generator is already running (resume() resolved the promise).
    // We need to drain the remaining events from the generator.
    // The loop exposes a way to get the running generator via its internal iterator.
    // Since we stored the loop reference in pausedLoops, we can call run() again
    // but that would start a new run. Instead, we need to drain the existing iterator.
    //
    // The cleanest approach: the loop's generator is still alive and paused at doPause.
    // After resume(), the generator will continue. We need the original for-await iterator.
    // Store it alongside the loop in pausedLoops.
    const iter = entry.iter
    if (iter) {
      outer2: for await (const event of { [Symbol.asyncIterator]: () => iter }) {
        switch (event.type) {
          case 'message_delta': finalContent += event.delta; break
          case 'tool_start': toolSequence.push(event.toolName); break
          case 'paused':
            pausedLoops.set(sessionId, { loop: entry.loop, pauseKind: (event.payload as { kind?: string })?.kind, iter: entry.iter })
            nextPauseInfo = { pauseId: event.pauseId, payload: event.payload }
            break outer2
          case 'agent_end':
            pausedLoops.delete(sessionId)
            totalTurns = event.totalTurns
            break
        }
      }
    }

    if (nextPauseInfo) {
      return reply.send({ ok: true, sessionId, paused: nextPauseInfo, response: finalContent, toolsUsed: toolSequence })
    }
    return reply.send({ ok: true, sessionId, response: finalContent, totalTurns, toolsUsed: toolSequence })
  })

  // ── GET /v1/agent/status ───────────────────────────────────────────────────

  fastify.get<{ Querystring: { sessionId: string } }>("/v1/agent/status", async (request, reply) => {
    if (opts.authToken) {
      const auth = request.headers["authorization"]
      if (!auth || auth !== `Bearer ${opts.authToken}`) {
        return reply.status(401).send({ error: "Unauthorized" })
      }
    }

    const { sessionId } = request.query
    if (!sessionId) {
      return reply.status(400).send({ error: "sessionId is required" })
    }

    const entry = pausedLoops.get(sessionId)
    const mode = opts.sessionStore
      ? ((opts.sessionStore.getMeta(sessionId, 'agent_mode') ?? 'auto') as AgentMode)
      : 'auto'

    if (entry?.loop.isPaused) {
      return reply.send({
        state: 'paused',
        pauseId: entry.loop.currentPauseId,
        mode,
        sessionId,
      })
    }

    return reply.send({ state: 'idle', mode, sessionId })
  })
}
