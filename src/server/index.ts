import Fastify, { type FastifyInstance } from "fastify"
import type { Config } from "../config/schema.js"
import type { ProviderRouter } from "../providers/router.js"
import type { SessionMemory } from "../memory/session.js"
import { healthRoute } from "./routes/health.js"
import { chatRoute } from "./routes/chat.js"

export async function buildServer(
  config: Config,
  router: ProviderRouter,
  memory: SessionMemory,
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false })

  await fastify.register(healthRoute)
  await fastify.register(chatRoute, {
    router,
    memory,
    authToken: config.server.authToken,
  })

  return fastify
}
