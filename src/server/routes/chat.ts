// src/server/routes/chat.ts
import type { FastifyInstance } from "fastify"
import type { ProviderRouter } from "../../providers/router.js"
import type { MemoryStrategy } from "../../memory/strategy.js"

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

    if (wantStream) {
      // SSE 流式：hijack 接管原始 socket，绕过 Fastify 自动 Content-Length
      reply.hijack()
      const raw = reply.raw
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      })

      let fullContent = ""

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
        raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`)
      } finally {
        raw.end()
      }

      // 后台追加 + 异步处理
      if (fullContent) {
        await opts.strategy.appendTurn(
          sid,
          { role: "user", content: message },
          { role: "assistant", content: fullContent },
        )
      }

      return
    }

    // 非流式
    const chatResponse = await opts.router.chat(allMessages, model ? { model } : undefined)

    await opts.strategy.appendTurn(
      sid,
      { role: "user", content: message },
      { role: "assistant", content: chatResponse.content },
    )

    return reply.send({
      response: chatResponse.content,
      sessionId: sid,
      model: chatResponse.model,
    })
  })
}
