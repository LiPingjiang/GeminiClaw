import type { FastifyInstance } from "fastify"

interface LocalConfigRouteOpts {
  authToken?: string
}

export async function localConfigRoute(
  fastify: FastifyInstance,
  opts: LocalConfigRouteOpts,
): Promise<void> {
  fastify.get("/v1/localconfig", async (_request, reply) => {
    return reply.send({ authToken: opts?.authToken ?? '' })
  })
}
