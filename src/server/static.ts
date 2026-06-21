import type { FastifyInstance } from 'fastify'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
// At runtime: dist/server/static.js → web/dist is at ../../web/dist
const WEB_DIST = join(__dirname, '../../web/dist')

export async function registerStatic(fastify: FastifyInstance): Promise<void> {
  if (!existsSync(WEB_DIST)) {
    fastify.log.warn(`web/dist not found — run 'pnpm build:web' to enable the web UI`)
    return
  }

  // @ts-ignore — @fastify/static types vary by version
  await fastify.register(import('@fastify/static'), {
    root: WEB_DIST,
    prefix: '/',
  })

  // SPA fallback: non-/v1 routes serve index.html
  fastify.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/v1')) {
      return reply.status(404).send({ error: 'Not found' })
    }
    // @ts-ignore
    return reply.sendFile('index.html')
  })
}
