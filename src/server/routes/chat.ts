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
// Maps sessionId → AgentLoop instance currently paused
const pausedLoops = new Map<string, AgentLoop>()

// ── Trace helper ──────────────────────────────────────────────────────────────

function recordTrace(
  evolution: EvolutionEngine | undefined,
  sessionId: string,
  hadFailure: boolean,
  messageCount: number,
  toolSequence: string[] = [],
  responseLength = 0,
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
        content: m.content,
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
              // Store loop reference so resume can find it
              pausedLoops.set(sid, loop)
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
        recordTrace(opts.evolution, sid, hadFailure, allMessages.length + 1, toolSequence, fullContent.length)
        return
      }

      // AgentLoop 非流式
      let finalContent = ""
      const toolSequence: string[] = []
      let hadFailure = false
      let totalTurns = 0
      let pauseInfo: { pauseId: string; payload: unknown } | null = null

      for await (const event of opts.agentLoop.run({
        messages: internalMessages,
        sessionId: sid,
        model,
        beforeToolCall,
      })) {
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
            pausedLoops.set(sid, opts.agentLoop)
            pauseInfo = { pauseId: event.pauseId, payload: event.payload }
            break
          case "agent_end":
            pausedLoops.delete(sid)
            totalTurns = event.totalTurns
            break
        }
      }

      await opts.strategy.appendTurn(
        sid,
        { role: "user", content: message },
        { role: "assistant", content: finalContent },
      )
      recordTrace(opts.evolution, sid, hadFailure, allMessages.length + 1, toolSequence, finalContent.length)

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
      recordTrace(opts.evolution, sid, streamFailed, allMessages.length + 1)
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
    recordTrace(opts.evolution, sid, chatFailed, allMessages.length + 1)

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

    const loop = pausedLoops.get(sessionId)
    if (!loop) {
      return reply.status(404).send({ error: "No paused loop found for this session" })
    }

    const ok = loop.resume(pauseId, input ?? '')
    if (!ok) {
      return reply.status(409).send({ error: "pauseId mismatch or loop is not paused" })
    }

    return reply.send({ ok: true, sessionId, pauseId })
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

    const loop = pausedLoops.get(sessionId)
    const mode = opts.sessionStore
      ? ((opts.sessionStore.getMeta(sessionId, 'agent_mode') ?? 'auto') as AgentMode)
      : 'auto'

    if (loop?.isPaused) {
      return reply.send({
        state: 'paused',
        pauseId: loop.currentPauseId,
        mode,
        sessionId,
      })
    }

    return reply.send({ state: 'idle', mode, sessionId })
  })
}
