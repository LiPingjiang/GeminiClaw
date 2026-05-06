// src/server/routes/chat.ts
import type { FastifyInstance } from "fastify"
import type { ProviderRouter } from "../../providers/router.js"
import type { MemoryStrategy } from "../../memory/strategy.js"
import type { EvolutionEngine } from "../../evolution/index.js"
import type { AgentLoop, InternalMessage } from "../../agent/index.js"

interface ChatBody {
  message: string
  sessionId?: string
  model?: string
  stream?: boolean
}

interface ChatRouteOpts {
  router: ProviderRouter
  strategy: MemoryStrategy
  authToken?: string
  evolution?: EvolutionEngine
  agentLoop?: AgentLoop
}

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
    // Notify idle loop that new trace data is available
    evolution.onTraceRecorded()
  })
}

export async function chatRoute(
  fastify: FastifyInstance,
  opts: ChatRouteOpts,
): Promise<void> {
  fastify.post<{ Body: ChatBody }>("/v1/agent/chat", async (request, reply) => {
    if (opts.authToken) {
      const auth = request.headers["authorization"]
      if (!auth || auth !== `Bearer ${opts.authToken}`) {
        return reply.status(401).send({ error: "Unauthorized" })
      }
    }

    const { message, sessionId, model, stream: wantStream } = request.body

    // 输入校验
    if (!message || typeof message !== "string" || message.trim() === "") {
      return reply.status(400).send({ error: "message is required and must be a non-empty string" })
    }

    const sid = sessionId ?? crypto.randomUUID()

    await opts.strategy.ensureSession(sid)

    // 1. 获取 context（含 system + 事项索引 + 历史）
    const { messages: contextMessages } = await opts.strategy.getContext(sid, message)

    // 2. 追加当前用户消息
    const allMessages = [...contextMessages, { role: "user" as const, content: message }]

    // AgentLoop path
    if (opts.agentLoop) {
      const internalMessages: InternalMessage[] = allMessages.map(m => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }))

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

        for await (const event of opts.agentLoop.run({
          messages: internalMessages,
          sessionId: sid,
          model,
        })) {
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
            case "agent_end":
              raw.write(`data: ${JSON.stringify({ type: "done" })}\n\n`)
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

      for await (const event of opts.agentLoop.run({
        messages: internalMessages,
        sessionId: sid,
        model,
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
          case "agent_end":
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
      })
    }

    // Fallback: legacy single-shot path (no AgentLoop)
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
            const data = JSON.stringify({ choices: [{ delta: { content: chunk.delta } }] })
            raw.write(`data: ${data}\n\n`)
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

    // Legacy non-stream
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
}
