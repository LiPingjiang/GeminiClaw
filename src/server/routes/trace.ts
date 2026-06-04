/**
 * /v1/trace/live — SSE 端点
 *
 * gc watch 连接此端点，实时接收 QQBot 对话的每个 AgentEvent。
 * 无需认证（本地调试用途），但只监听，不写入。
 *
 * 事件格式（SSE）：
 *   data: {"ts":1234567890,"userId":"abc12345...","sessionId":"xxx","agentEvent":{...}}\n\n
 *
 * 心跳：每 15s 发一次 `: ping\n\n`，防止连接超时。
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify"
import { traceHub } from "../../trace/hub.js"
import type { TraceEvent } from "../../trace/hub.js"

export async function traceRoute(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  fastify.get("/v1/trace/live", async (request, reply) => {
    // SSE headers
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })

    // 发送初始连接确认
    reply.raw.write(": connected\n\n")

    // 心跳定时器（15s）
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) {
        reply.raw.write(": ping\n\n")
      }
    }, 15_000)

    // 订阅 TraceHub
    const unsubscribe = traceHub.subscribe((event: TraceEvent) => {
      if (reply.raw.destroyed) return
      const data = JSON.stringify(event)
      reply.raw.write(`data: ${data}\n\n`)
    })

    // 客户端断开时清理
    request.raw.on("close", () => {
      clearInterval(heartbeat)
      unsubscribe()
    })

    // 保持连接（不 resolve）
    await new Promise<void>((resolve) => {
      request.raw.on("close", resolve)
    })
  })
}
