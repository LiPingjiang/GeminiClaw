/**
 * Async Runs Route — /v1/runs
 *
 * Endpoints:
 * - POST /v1/runs          — Create an async run, returns runId immediately
 * - GET  /v1/runs/:id/events — SSE stream of run events (real-time, no polling)
 * - GET  /v1/runs/:id       — Get run status + result (REST)
 * - POST /v1/runs/:id/cancel — Cancel a pending/running run
 */

import type { FastifyInstance } from "fastify"
import type { RunStore, RunEvent } from "./run-store.js"
import type { ProviderRouter } from "../../providers/router.js"
import type { MemoryStrategy } from "../../memory/strategy.js"
import type { Message } from "../../providers/types.js"

// ── Route Options ────────────────────────────────────────────────────────────

export interface RunsRouteOpts {
  runStore: RunStore
  router: ProviderRouter
  strategy?: MemoryStrategy
  authToken?: string
  /** Optional agent loop for tool-augmented runs */
  agentLoop?: {
    run(params: {
      messages: Array<{ role: string; content: string }>
      sessionId: string
      model?: string
    }): AsyncIterable<{ type: string; delta?: string; tool?: string; args?: unknown; result?: unknown }>
  }
}

// ── Route Registration ───────────────────────────────────────────────────────

export async function runsRoute(
  fastify: FastifyInstance,
  opts: RunsRouteOpts,
): Promise<void> {
  const { runStore, router, strategy, authToken, agentLoop } = opts

  // ── Auth Helper ──────────────────────────────────────────────────────────

  function checkAuth(request: { headers: Record<string, string | string[] | undefined> }): string | null {
    if (!authToken) return null
    const auth = request.headers["authorization"]
    if (!auth || auth !== `Bearer ${authToken}`) {
      return "Unauthorized"
    }
    return null
  }

  // ── POST /v1/runs ────────────────────────────────────────────────────────

  fastify.post<{
    Body: { message: string; sessionId?: string; model?: string }
  }>("/v1/runs", async (request, reply) => {
    const authErr = checkAuth(request)
    if (authErr) return reply.status(401).send({ error: authErr })

    const { message, sessionId, model } = request.body

    if (!message || typeof message !== "string" || message.trim() === "") {
      return reply.status(400).send({ error: "message is required and must be a non-empty string" })
    }

    const sid = sessionId ?? `run-${Date.now()}`
    const runId = runStore.create(sid)

    // Fire-and-forget: execute the run asynchronously
    setImmediate(async () => {
      runStore.setRunning(runId)

      try {
        // Build message history
        let priorMessages: Array<{ role: string; content: string }> = []
        if (strategy) {
          await strategy.ensureSession(sid)
          const ctx = await strategy.getContext(sid, message)
          priorMessages = (ctx.messages ?? []).map((m) => ({
            role: m.role === "tool" ? "user" : (m.role as string),
            content: typeof m.content === "string" ? m.content : "",
          }))
        }

        const messages = [
          ...priorMessages as Message[],
          { role: "user" as const, content: message },
        ] as any

        if (agentLoop) {
          // Agent loop mode: stream with tool calls
          let fullContent = ""
          for await (const event of agentLoop.run({ messages, sessionId: sid, model })) {
            if (event.type === "message_delta" && event.delta) {
              fullContent += event.delta
              runStore.appendDelta(runId, event.delta)
            } else if (event.type === "tool_call") {
              runStore.appendToolCall(runId, event.tool ?? "unknown", event.args)
            } else if (event.type === "tool_result") {
              runStore.appendToolResult(runId, event.tool ?? "unknown", event.result)
            }
          }

          if (strategy && fullContent) {
            await strategy.appendTurn(
              sid,
              { role: "user", content: message },
              { role: "assistant", content: fullContent },
            )
          }
          runStore.complete(runId, fullContent)
        } else {
          // Simple router mode: stream directly
          let fullContent = ""
          for await (const chunk of router.stream(messages, model ? { model } : undefined)) {
            if (chunk.delta) {
              fullContent += chunk.delta
              runStore.appendDelta(runId, chunk.delta)
            }
          }

          if (strategy && fullContent) {
            await strategy.appendTurn(
              sid,
              { role: "user", content: message },
              { role: "assistant", content: fullContent },
            )
          }
          runStore.complete(runId, fullContent)
        }
      } catch (err) {
        runStore.fail(runId, err instanceof Error ? err.message : String(err))
      }
    })

    return reply.status(202).send({ runId, sessionId: sid, status: "pending" })
  })

  // ── GET /v1/runs/:id/events ──────────────────────────────────────────────

  fastify.get<{
    Params: { id: string }
  }>("/v1/runs/:id/events", async (request, reply) => {
    const { id } = request.params
    const run = runStore.get(id)

    if (!run) {
      return reply.status(404).send({ error: `Run ${id} not found` })
    }

    // Hijack for SSE
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })

    const sendSSE = (event: string, data: unknown): void => {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    // Replay existing events for late-joining clients
    for (const event of run.events) {
      sendSSE(event.type, event.data)
    }

    // If already terminal, close immediately
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      raw.end()
      return
    }

    // Subscribe to real-time events
    let closed = false
    const unsubscribe = runStore.subscribe(id, (event: RunEvent) => {
      if (closed) return
      sendSSE(event.type, event.data)

      // Terminal events: close the stream
      if (event.type === "done" || event.type === "error") {
        closed = true
        unsubscribe()
        raw.end()
      }
    })

    // Client disconnect: cleanup
    request.raw.on("close", () => {
      if (!closed) {
        closed = true
        unsubscribe()
      }
    })
  })

  // ── GET /v1/runs/:id ─────────────────────────────────────────────────────

  fastify.get<{
    Params: { id: string }
  }>("/v1/runs/:id", async (request, reply) => {
    const { id } = request.params
    const run = runStore.get(id)

    if (!run) {
      return reply.status(404).send({ error: `Run ${id} not found` })
    }

    return reply.send({
      id: run.id,
      status: run.status,
      sessionId: run.sessionId,
      result: run.result,
      error: run.error,
      eventCount: run.events.length,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    })
  })

  // ── POST /v1/runs/:id/cancel ─────────────────────────────────────────────

  fastify.post<{
    Params: { id: string }
  }>("/v1/runs/:id/cancel", async (request, reply) => {
    const authErr = checkAuth(request)
    if (authErr) return reply.status(401).send({ error: authErr })

    const { id } = request.params
    const run = runStore.get(id)

    if (!run) {
      return reply.status(404).send({ error: `Run ${id} not found` })
    }

    const cancelled = runStore.cancel(id)
    if (!cancelled) {
      return reply.status(409).send({
        error: `Cannot cancel run in ${run.status} state`,
      })
    }

    return reply.send({ id, status: "cancelled" })
  })
}
