// src/server/routes/runs.ts
import type { FastifyInstance, FastifyPluginOptions } from "fastify"
import type { RunStore } from "./run-store.js"

export interface RunsRouteOptions extends FastifyPluginOptions {
  runStore: RunStore
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
}
