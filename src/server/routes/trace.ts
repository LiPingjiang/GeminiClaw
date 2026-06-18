// src/server/routes/trace.ts
import type { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { traceHub } from '../../trace/hub.js'
import type { TraceEvent } from '../../trace/hub.js'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export async function traceRoute(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  fastify.get<{ Querystring: { session?: string; tail?: string } }>(
    '/v1/trace/live',
    async (request, reply) => {
      const { session, tail } = request.query

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      reply.raw.write(': connected\n\n')

      // Replay tail events from today's trace file if requested
      if (tail) {
        const n = parseInt(tail, 10) || 50
        const date = new Date().toISOString().slice(0, 10)
        const path = join(homedir(), '.gemeniclaw', 'audit', `trace-${date}.jsonl`)
        if (existsSync(path)) {
          const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean)
          const recent = lines.slice(-n)
          for (const line of recent) {
            try {
              const event = JSON.parse(line) as TraceEvent
              if (session && !event.sessionId.startsWith(session)) continue
              reply.raw.write(`data: ${line}\n\n`)
            } catch { /* skip malformed lines */ }
          }
        }
      }

      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(': ping\n\n')
      }, 15_000)

      const unsubscribe = traceHub.subscribe((event: TraceEvent) => {
        if (reply.raw.destroyed) return
        if (session && !event.sessionId.startsWith(session)) return
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
      })

      request.raw.on('close', () => {
        clearInterval(heartbeat)
        unsubscribe()
      })

      await new Promise<void>((resolve) => request.raw.on('close', resolve))
    },
  )
}
