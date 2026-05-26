// src/server/index.ts
import Fastify, { type FastifyInstance } from "fastify"
import type { Db } from "../db/client.js"
import type { Config } from "../config/schema.js"
import type { ProviderRouter } from "../providers/router.js"
import type { MemoryStrategy } from "../memory/strategy.js"
import { healthRoute } from "./routes/health.js"
import { chatRoute } from "./routes/chat.js"

export async function buildServer(
  config: Config,
  router: ProviderRouter,
  strategy: MemoryStrategy,
  db?: Db,
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false })

  await fastify.register(healthRoute)
  await fastify.register(chatRoute, {
    router,
    strategy,
    authToken: config.server.authToken,
  })

  return fastify
}
