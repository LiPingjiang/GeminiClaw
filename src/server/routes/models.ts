import type { FastifyInstance } from "fastify"
import type { ProviderRouter } from "../../providers/router.js"

interface ModelsRouteOpts {
  router: ProviderRouter
  authToken?: string
}

export async function modelsRoute(
  fastify: FastifyInstance,
  opts: ModelsRouteOpts,
): Promise<void> {
  fastify.get("/v1/models", async (request, reply) => {
    if (opts.authToken) {
      const auth = (request.headers as Record<string, string>)["authorization"]
      if (!auth || auth !== `Bearer ${opts.authToken}`) {
        return reply.status(401).send({ error: { message: "Unauthorized", type: "auth_error" } })
      }
    }
    const models = opts.router.listModels().map((id: string) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "geminiclaw",
    }))
    return reply.send({ object: "list", data: models })
  })
}
