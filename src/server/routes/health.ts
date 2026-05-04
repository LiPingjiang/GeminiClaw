import type { FastifyInstance } from "fastify"

export async function healthRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get("/v1/health", async (_request, reply) => {
    return reply.send({ status: "ok", timestamp: new Date().toISOString() })
  })
}
