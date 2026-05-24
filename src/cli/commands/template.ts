// src/cli/commands/template.ts
import { Command } from "commander"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import * as readline from "readline"
import { TemplateManager } from "../../templates/manager.js"
import { printOutput, printError, type OutputFormat } from "../lib/output.js"
import type { TemplateMeta } from "../../templates/schema.js"

// ── Helper: interactive prompt ─────────────────────────────────────────────

async function prompt(question: string, defaultVal?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    const hint = defaultVal ? ` [${defaultVal}]` : ""
    rl.question(`${question}${hint}: `, (answer) => {
      rl.close()
      resolve(answer.trim() || defaultVal || "")
    })
  })
}

// ── Helper: format meta for human display ─────────────────────────────────

function formatMetaRow(meta: TemplateMeta): string {
  const name = meta.name.padEnd(20)
  const displayName = (meta.display_name ?? "").padEnd(12)
  const desc = meta.description ?? ""
  return `  ${name}  ${displayName}  ${desc}`
}

// ── Command registration ───────────────────────────────────────────────────

export function registerTemplateCommand(program: Command): void {
  const tmpl = program
    .command("template")
    .description(
      `Template management — list, inspect, create, copy agent templates

WHAT
  Manages agent templates in ~/.gemeniclaw/templates/.
  Each template has template.yaml (metadata), AGENT.md (persona),
  and optionally a skills/ directory.

WHEN (agent guidance)
  Call \`gc template list\` to see all available agent templates.
  Call \`gc template show <name>\` to inspect a template before using it.
  Call \`gc template create <name>\` to create a new template from base.
  Call \`gc template copy <src> <dst>\` to duplicate an existing template.

TEMPLATE STRUCTURE
  ~/.gemeniclaw/templates/<name>/
  ├── template.yaml   — metadata (name, display_name, description, keywords)
  ├── AGENT.md        — agent persona / system prompt
  └── skills/         — skill definitions

OUTPUT
  All commands support --json for machine-readable output.
  Default output is human-readable with emoji indicators.`
    )

  // ── gc template list ──────────────────────────────────────────────────────
  tmpl
    .command("list")
    .description("List all agent templates")
    .option("--json", "Output as JSON")
    .action((opts) => {
      const format: OutputFormat = opts.json ? "json" : "human"
      try {
        const manager = new TemplateManager()
        const templates = manager.list()

        if (format === "json") {
          printOutput(templates, "", format)
          return
        }

        if (templates.length === 0) {
          console.log("📭 No templates found.\n   Run `gc template create <name>` to create one.")
          return
        }

        const header = `${"Name".padEnd(20)}  ${"Display Name".padEnd(12)}  Description`
        const sep = "─".repeat(72)
        const rows = templates.map(formatMetaRow)

        console.log(`🗂  Agent Templates — ${templates.length} total\n`)
        console.log(`  ${header}`)
        console.log(`  ${sep}`)
        rows.forEach((r) => console.log(r))
        console.log(`\nRun \`gc template show <name>\` for details.`)
      } catch (e) {
        printError(String(e), format)
      }
    })

  // ── gc template show <name> ───────────────────────────────────────────────
  tmpl
    .command("show <name>")
    .description("Show template details (metadata + AGENT.md preview)")
    .option("--json", "Output as JSON")
    .action((name, opts) => {
      const format: OutputFormat = opts.json ? "json" : "human"
      try {
        const manager = new TemplateManager()
        const info = manager.get(name)
        if (!info) {
          printError(`Template not found: ${name}`, format)
          return
        }

        const agentMdContent = manager.loadAgentMd(name)
        const agentMdPreview = agentMdContent
          ? agentMdContent.slice(0, 600) + (agentMdContent.length > 600 ? "\n..." : "")
          : "(no AGENT.md)"

        const data = {
          meta: info.meta,
          agentMdPath: info.agentMdPath,
          skillsDir: info.skillsDir,
          agentMdPreview,
        }

        if (format === "json") {
          printOutput(data, "", format)
          return
        }

        const meta = info.meta
        console.log(`\n📋 Template: ${meta.name}`)
        console.log(`   Display Name : ${meta.display_name ?? "(none)"}`)
        console.log(`   Description  : ${meta.description || "(none)"}`)
        console.log(`   Keywords     : ${meta.keywords?.join(", ") || "(none)"}`)
        if (meta.created_at) console.log(`   Created At   : ${meta.created_at}`)
        if (meta.copied_from) console.log(`   Copied From  : ${meta.copied_from}`)
        console.log(`   AGENT.md     : ${info.agentMdPath}`)
        console.log(`   Skills Dir   : ${info.skillsDir}`)
        console.log(`\n--- AGENT.md preview ---`)
        console.log(agentMdPreview)
      } catch (e) {
        printError(String(e), format)
      }
    })

  // ── gc template create <name> ─────────────────────────────────────────────
  tmpl
    .command("create <name>")
    .description("Create a new template from base (interactive)")
    .option("--display-name <displayName>", "Template display name")
    .option("--description <description>", "Template description")
    .option("--keywords <keywords>", "Comma-separated keywords")
    .option("--json", "Output as JSON")
    .action(async (name, opts) => {
      const format: OutputFormat = opts.json ? "json" : "human"
      try {
        const manager = new TemplateManager()

        // Check if target already exists
        if (manager.get(name)) {
          printError(`Template already exists: ${name}`, format)
          return
        }

        // Ensure base exists first
        manager.ensureBase()

        if (!manager.get("base")) {
          printError("Base template not found. Run the server once to initialize it.", format)
          return
        }

        // Gather metadata (interactive or from flags)
        let displayName: string
        let description: string
        let keywords: string[]

        if (opts.json) {
          // Non-interactive mode: use flags, fill in defaults
          displayName = opts.displayName ?? name
          description = opts.description ?? ""
          keywords = opts.keywords ? opts.keywords.split(",").map((k: string) => k.trim()).filter(Boolean) : []
        } else {
          console.log(`\n✨ Creating new template: ${name}\n`)
          displayName = opts.displayName
            ?? await prompt("Display name", name)
          description = opts.description
            ?? await prompt("Description", "")
          const keywordsInput = opts.keywords
            ?? await prompt("Keywords (comma-separated)", "")
          keywords = keywordsInput.split(",").map((k: string) => k.trim()).filter(Boolean)
        }

        // Copy from base
        manager.copy("base", name)

        // Patch template.yaml with the gathered metadata
        const info = manager.get(name)!
        const yaml = await import("js-yaml")
        const metaPath = join(info.agentMdPath, "..", "template.yaml")
        const currentMeta = yaml.load(readFileSync(metaPath, "utf-8")) as Record<string, unknown>
        const updatedMeta = {
          ...currentMeta,
          display_name: displayName,
          description,
          keywords,
        }
        writeFileSync(metaPath, yaml.dump(updatedMeta, { lineWidth: 100 }), "utf-8")

        const finalInfo = manager.get(name)!
        const data = { template: finalInfo.meta, path: manager["templateDir"](name) }

        if (format === "json") {
          printOutput(data, "", format)
          return
        }

        console.log(`\n✅ Template created: ${name}`)
        console.log(`   Location : ${manager["templateDir"](name)}`)
        console.log(`   AGENT.md : ${finalInfo.agentMdPath}`)
        console.log(`\nEdit the template:`)
        console.log(`   $EDITOR ${finalInfo.agentMdPath}`)
      } catch (e) {
        printError(String(e), format)
      }
    })

  // ── gc template copy <src> <dst> ──────────────────────────────────────────
  tmpl
    .command("copy <src> <dst>")
    .description("Copy an existing template to a new name")
    .option("--json", "Output as JSON")
    .action((src, dst, opts) => {
      const format: OutputFormat = opts.json ? "json" : "human"
      try {
        const manager = new TemplateManager()
        manager.copy(src, dst)
        const info = manager.get(dst)!

        const data = { copied_from: src, template: info.meta }

        if (format === "json") {
          printOutput(data, "", format)
          return
        }

        console.log(`✅ Copied template: ${src} → ${dst}`)
        console.log(`   Location: ${manager["templateDir"](dst)}`)
      } catch (e) {
        printError(String(e), format)
      }
    })
}
