// @ts-nocheck
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { TemplateManager } from "../../templates/manager.js";
function checkAuth(request, authToken) {
    if (!authToken)
        return true;
    const auth = request.headers["authorization"];
    return typeof auth === "string" && auth === `Bearer ${authToken}`;
}
export async function templatesRoute(fastify, opts) {
    const { authToken } = opts;
    const manager = new TemplateManager();
    // ── GET /v1/templates ─────────────────────────────────────────────────────
    // List all templates
    fastify.get("/v1/templates", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const templates = manager.list();
        return reply.send({ templates, total: templates.length });
    });
    // ── GET /v1/templates/:name ───────────────────────────────────────────────
    // Get template details (metadata + AGENT.md content)
    fastify.get("/v1/templates/:name", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const { name } = request.params;
        const info = manager.get(name);
        if (!info) {
            return reply.status(404).send({ error: `Template not found: ${name}` });
        }
        const agentMd = manager.loadAgentMd(name);
        return reply.send({
            template: info.meta,
            agentMdPath: info.agentMdPath,
            skillsDir: info.skillsDir,
            agentMd: agentMd ?? null,
        });
    });
    // ── POST /v1/templates ────────────────────────────────────────────────────
    // Create a new template
    // Body: { name, display_name?, description?, keywords?, copy_from? }
    fastify.post("/v1/templates", async (request, reply) => {
        if (!checkAuth(request, authToken)) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
        const body = request.body;
        if (!body?.name) {
            return reply.status(400).send({ error: "Missing required field: name" });
        }
        const { name, display_name, description, keywords, copy_from } = body;
        // Validate name (alphanumeric, hyphens, underscores)
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
            return reply.status(400).send({
                error: "Invalid template name. Use only letters, numbers, hyphens, and underscores.",
            });
        }
        if (manager.get(name)) {
            return reply.status(409).send({ error: `Template already exists: ${name}` });
        }
        // Ensure base template exists
        manager.ensureBase();
        const copySource = copy_from ?? "base";
        if (!manager.get(copySource)) {
            return reply.status(404).send({ error: `Source template not found: ${copySource}` });
        }
        try {
            manager.copy(copySource, name);
            // Patch metadata with provided values
            const info = manager.get(name);
            const metaPath = join(info.agentMdPath, "..", "template.yaml");
            const currentMeta = yaml.load(readFileSync(metaPath, "utf-8"));
            const updatedMeta = { ...currentMeta };
            if (display_name !== undefined)
                updatedMeta.display_name = display_name;
            if (description !== undefined)
                updatedMeta.description = description;
            if (keywords !== undefined)
                updatedMeta.keywords = keywords;
            writeFileSync(metaPath, yaml.dump(updatedMeta, { lineWidth: 100 }), "utf-8");
            const finalInfo = manager.get(name);
            return reply.status(201).send({ template: finalInfo.meta });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return reply.status(500).send({ error: msg });
        }
    });
}
