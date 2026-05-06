import type { FastifyInstance } from "fastify"

export async function healthRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get("/v1/health", async (_request, reply) => {
    reply.header("X-GeminiClaw-Version", process.env.npm_package_version ?? "unknown")
    reply.header("X-Powered-By", "GeminiClaw")
    return reply.send({ status: "ok", timestamp: new Date().toISOString() })
  })
}
