/**
 * /v1/agent/stream — AgentLoop 原生事件 SSE 流
 *
 * 专为 TUI 设计：直接把 AgentLoop 的 AgentEvent 以 SSE 推出去，
 * 不经过 RunStore 的转换层，保留完整的 tool_start/tool_end/turn_start 等事件。
 *
 * POST /v1/agent/stream
 *   Body: { message, sessionId?, model? }
 *   Response: text/event-stream
 *     event: agent_event
 *     data: <AgentEvent JSON>
 *
 *     event: done
 *     data: {"sessionId":"..."}
 */

import type { FastifyInstance } from "fastify"
import type { ProviderRouter } from "../../providers/router.js"
import type { MemoryStrategy } from "../../memory/strategy.js"
import type { AgentLoop } from "../../agent/loop.js"
import type { ContentPart } from "../../providers/types.js"

interface StreamBody {
  message: string
  sessionId?: string
  model?: string
  attachments?: Array<{ type: 'image'; mediaType: string; data: string }>
  ephemeral?: boolean
}

interface StreamRouteOpts {
  router: ProviderRouter
  strategy: MemoryStrategy
  authToken?: string
  agentLoop: AgentLoop
}

export async function streamRoute(
  fastify: FastifyInstance,
  opts: StreamRouteOpts,
): Promise<void> {
  fastify.post<{ Body: StreamBody }>("/v1/agent/stream", async (request, reply) => {
    // ── Auth ──────────────────────────────────────────────────────────────────
    if (opts.authToken) {
      const auth = request.headers["authorization"]
      if (!auth || auth !== `Bearer ${opts.authToken}`) {
        return reply.status(401).send({ error: "Unauthorized" })
      }
    }

    const { message, sessionId, model, attachments } = request.body

    if (!message || typeof message !== "string" || message.trim() === "") {
      return reply.status(400).send({ error: "message is required and must be a non-empty string" })
    }

    const sid = sessionId ?? crypto.randomUUID()

    // ── 准备消息历史（在 hijack 之前，失败可以正常返回 HTTP 错误） ──────────
    let contextMessages: Awaited<ReturnType<typeof opts.strategy.getContext>>["messages"]
    try {
      await opts.strategy.ensureSession(sid)
      const ctx = await opts.strategy.getContext(sid, message)
      contextMessages = ctx.messages
    } catch (err) {
      return reply.status(500).send({ error: `Memory error: ${String(err)}` })
    }

    const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

    // Build user message content (multimodal if attachments present)
    const userContent: unknown = attachments?.length
      ? [
          { type: 'text', text: message },
          ...attachments
            .filter(a => ALLOWED_MEDIA_TYPES.has(a.mediaType))
            .map(a => ({
              type: 'image',
              source: { type: 'base64', media_type: a.mediaType, data: a.data },
            })),
        ]
      : message

    const allMessages = [
      ...contextMessages,
      { role: "user" as const, content: userContent },
    ]

    // ── Hijack → SSE ──────────────────────────────────────────────────────────
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    })

    const sendEvent = (eventType: string, data: unknown): void => {
      raw.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    let fullContent = ""

    try {
      for await (const event of opts.agentLoop.run({
        messages: allMessages as Parameters<typeof opts.agentLoop.run>[0]["messages"],
        sessionId: sid,
        model,
      })) {
        // 把每个 AgentEvent 原样推出去
        sendEvent("agent_event", event)

        // After emitting tool_end, check for diff payload and emit extra agent_event
        if (event.type === "tool_end") {
          const mm = (event.result as any)?.multimodal
          if (Array.isArray(mm) && mm[0]?.type === 'diff') {
            const diffPayload = mm[0] as any
            sendEvent("agent_event", {
              type: 'diff',
              filename: diffPayload.filename,
              before: diffPayload.before,
              after: diffPayload.after,
            })
          }
        }

        // 同时累积 response 内容（用于存 memory）
        if (event.type === "message_delta" && "delta" in event) {
          fullContent += (event as { delta: string }).delta
        }
      }
    } catch (err) {
      sendEvent("error", { error: String(err) })
    }

    // 存 memory (skip for ephemeral requests)
    if (fullContent && !request.body.ephemeral) {
      try {
        await opts.strategy.appendTurn(
          sid,
          { role: "user" as const, content: userContent as string | ContentPart[] },
          { role: "assistant", content: fullContent },
        )
      } catch (err) {
        // Memory save failure should not crash the stream response
        console.error("[streamRoute] appendTurn failed:", err)
      }
    }

    sendEvent("done", { sessionId: sid })
    raw.write("data: [DONE]\n\n")
    raw.end()
  })
}
