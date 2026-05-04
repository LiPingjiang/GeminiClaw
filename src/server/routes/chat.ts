import type { FastifyInstance } from "fastify"
import type { ProviderRouter } from "../../providers/router.js"
import type { SessionMemory } from "../../memory/session.js"

interface ChatBody {
  message: string
  sessionId?: string
  model?: string
}

interface ChatRouteOpts {
  router: ProviderRouter
  memory: SessionMemory
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

    const { message, sessionId, model } = request.body
    const sid = sessionId ?? opts.memory.generateId()
    const history = opts.memory.get(sid)

    opts.memory.append(sid, { role: "user", content: message })

    const messages = [...history, { role: "user" as const, content: message }]
    const chatResponse = await opts.router.chat(messages, model ? { model } : undefined)

    opts.memory.append(sid, { role: "assistant", content: chatResponse.content })

    return reply.send({
      response: chatResponse.content,
      sessionId: sid,
      model: chatResponse.model,
    })
  })
}
