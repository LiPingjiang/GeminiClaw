// src/server/routes/runs.ts
import type { FastifyInstance, FastifyPluginOptions } from "fastify"
import type { RunStore } from "./run-store.js"
import type { AgentLoop } from "../../agent/loop.js"
import type { MemoryStrategy } from "../../memory/strategy.js"

export interface RunsRouteOptions extends FastifyPluginOptions {
  runStore: RunStore
  agentLoop: AgentLoop
  sessionStore?: MemoryStrategy
  authToken?: string
}

export async function runsRoute(
  fastify: FastifyInstance,
  options: RunsRouteOptions
): Promise<void> {
  const { runStore } = options

  fastify.get<{ Params: { id: string } }>(
    "/v1/runs/:id/events",
    async (req, reply) => {
      const { id } = req.params
      const run = runStore.get(id)

      if (!run) {
        return reply.status(404).send({ error: `Run ${id} not found` })
      }

      // Set SSE headers
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })

      const sendEvent = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      if (run.status === "completed") {
        sendEvent("message", { content: run.result ?? "" })
        sendEvent("done", { runId: id })
        reply.raw.end()
        return reply
      }

      if (run.status === "failed") {
        sendEvent("error", { error: run.error ?? "Unknown error" })
        reply.raw.end()
        return reply
      }

      // Still running: poll until done (max 5 min)
      const maxWaitMs = 5 * 60 * 1000
      const startMs = Date.now()
      const checkInterval = 500

      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const current = runStore.get(id)!
          if (current.status === "completed") {
            sendEvent("message", { content: current.result ?? "" })
            sendEvent("done", { runId: id })
            clearInterval(timer)
            resolve()
          } else if (current.status === "failed") {
            sendEvent("error", { error: current.error ?? "Unknown error" })
            clearInterval(timer)
            resolve()
          } else if (Date.now() - startMs > maxWaitMs) {
            sendEvent("error", { error: "Run timed out" })
            clearInterval(timer)
            resolve()
          }
        }, checkInterval)

        req.raw.on("close", () => {
          clearInterval(timer)
          resolve()
        })
      })

      reply.raw.end()
      return reply
    }
  )

  // ── POST /v1/runs ─────────────────────────────────────────────────────────
  // Create an async run. Returns runId immediately; use GET /v1/runs/:id/events to stream results.
  fastify.post<{
    Body: { message: string; sessionId?: string; model?: string }
  }>("/v1/runs", async (req, reply) => {
    if (options.authToken) {
      const auth = req.headers["authorization"]
      if (!auth || auth !== `Bearer ${options.authToken}`) {
        return reply.status(401).send({ error: "Unauthorized" })
      }
    }

    const { message, sessionId, model } = req.body
    if (!message) return reply.status(400).send({ error: "message is required" })

    const sid = sessionId ?? `run-${Date.now()}`
    const runId = options.runStore.create()
    options.runStore.setRunning(runId)

    // Fire-and-forget: run agent in background
    ;(async () => {
      try {
        // Get conversation context via MemoryStrategy
        type IM = import('../../agent/loop.js').InternalMessage
        let priorMessages: IM[] = []
        if (options.sessionStore) {
          await options.sessionStore.ensureSession(sid)
          const ctx = await options.sessionStore.getContext(sid, message)
          priorMessages = (ctx.messages ?? []).map(m => ({
            role: (m.role === 'tool' ? 'user' : m.role) as 'user' | 'assistant' | 'system',
            content: typeof m.content === 'string' ? m.content : '',
          }))
        }
        const messages: IM[] = [
          ...priorMessages,
          { role: 'user' as const, content: message },
        ]

        let finalContent = ""
        for await (const event of options.agentLoop.run({ messages, sessionId: sid, model })) {
          if (event.type === "message_delta") finalContent += event.delta
        }

        if (options.sessionStore) {
          await options.sessionStore.appendTurn(
            sid,
            { role: "user", content: message },
            { role: "assistant", content: finalContent },
          )
        }

        options.runStore.complete(runId, finalContent)
      } catch (err) {
        options.runStore.fail(runId, err instanceof Error ? err.message : String(err))
      }
    })()

    return reply.status(202).send({ runId, sessionId: sid })
  })
}
