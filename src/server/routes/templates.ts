// src/server/routes/templates.ts
import type { FastifyInstance } from "fastify"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import yaml from "js-yaml"
import { TemplateManager } from "../../templates/manager.js"

interface TemplatesOpts {
  authToken?: string
}

function checkAuth(
  request: { headers: Record<string, string | string[] | undefined> },
  authToken?: string
): boolean {
  if (!authToken) return true
  const auth = request.headers["authorization"]
  return typeof auth === "string" && auth === `Bearer ${authToken}`
}

export async function templatesRoute(
  fastify: FastifyInstance,
  opts: TemplatesOpts
): Promise<void> {
  const { authToken } = opts
  const manager = new TemplateManager()

  // ── GET /v1/templates ─────────────────────────────────────────────────────
  // List all templates
  fastify.get("/v1/templates", async (request, reply) => {
    if (!checkAuth(request as any, authToken)) {
      return reply.status(401).send({ error: "Unauthorized" })
    }
    const templates = manager.list()
    return reply.send({ templates, total: templates.length })
  })

  // ── GET /v1/templates/:name ───────────────────────────────────────────────
  // Get template details (metadata + AGENT.md content)
  fastify.get<{ Params: { name: string } }>(
    "/v1/templates/:name",
    async (request, reply) => {
      if (!checkAuth(request as any, authToken)) {
        return reply.status(401).send({ error: "Unauthorized" })
      }

      const { name } = request.params
      const info = manager.get(name)
      if (!info) {
        return reply.status(404).send({ error: `Template not found: ${name}` })
      }

      const agentMd = manager.loadAgentMd(name)
      return reply.send({
        template: info.meta,
        agentMdPath: info.agentMdPath,
        skillsDir: info.skillsDir,
        agentMd: agentMd ?? null,
      })
    }
  )

  // ── POST /v1/templates ────────────────────────────────────────────────────
  // Create a new template
  // Body: { name, display_name?, description?, keywords?, copy_from? }
  fastify.post("/v1/templates", async (request, reply) => {
    if (!checkAuth(request as any, authToken)) {
      return reply.status(401).send({ error: "Unauthorized" })
    }

    const body = request.body as {
      name?: string
      display_name?: string
      description?: string
      keywords?: string[]
      copy_from?: string
    }

    if (!body?.name) {
      return reply.status(400).send({ error: "Missing required field: name" })
    }

    const { name, display_name, description, keywords, copy_from } = body

    // Validate name (alphanumeric, hyphens, underscores)
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return reply.status(400).send({
        error: "Invalid template name. Use only letters, numbers, hyphens, and underscores.",
      })
    }

    if (manager.get(name)) {
      return reply.status(409).send({ error: `Template already exists: ${name}` })
    }

    // Ensure base template exists
    manager.ensureBase()

    const copySource = copy_from ?? "base"
    if (!manager.get(copySource)) {
      return reply.status(404).send({ error: `Source template not found: ${copySource}` })
    }

    try {
      manager.copy(copySource, name)

      // Patch metadata with provided values
      const info = manager.get(name)!
      const metaPath = join(info.agentMdPath, "..", "template.yaml")
      const currentMeta = yaml.load(readFileSync(metaPath, "utf-8")) as Record<string, unknown>
      const updatedMeta: Record<string, unknown> = { ...currentMeta }
      if (display_name !== undefined) updatedMeta.display_name = display_name
      if (description !== undefined) updatedMeta.description = description
      if (keywords !== undefined) updatedMeta.keywords = keywords

      writeFileSync(metaPath, yaml.dump(updatedMeta, { lineWidth: 100 }), "utf-8")

      const finalInfo = manager.get(name)!
      return reply.status(201).send({ template: finalInfo.meta })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return reply.status(500).send({ error: msg })
    }
  })
}
