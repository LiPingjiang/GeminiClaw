import { Command } from "commander"
import { existsSync, readFileSync, appendFileSync } from "fs"
import { join } from "path"
import { resolveWorkspace } from "../lib/workspace.js"
import { printOutput, printError, type OutputFormat } from "../lib/output.js"

export function readMemory(workspaceRoot: string): string | null {
  const p = join(workspaceRoot, "MEMORY.md")
  return existsSync(p) ? readFileSync(p, "utf-8") : null
}

export function readDailyMemory(workspaceRoot: string, date: string): string | null {
  const p = join(workspaceRoot, "memory", `${date}.md`)
  return existsSync(p) ? readFileSync(p, "utf-8") : null
}

export function appendMemory(workspaceRoot: string, text: string): void {
  const p = join(workspaceRoot, "MEMORY.md")
  const ts = new Date().toISOString().slice(0, 10)
  appendFileSync(p, `\n- [${ts}] ${text}\n`, "utf-8")
}

export function registerMemoryCommand(program: Command): void {
  const memory = program
    .command("memory")
    .description(
      `Memory management — long-term and daily memories

WHAT
  Reads and writes MEMORY.md (long-term) and memory/YYYY-MM-DD.md (daily).

WHEN (agent guidance)
  Call \`gc memory show\` to recall long-term knowledge before complex tasks.
  Call \`gc memory daily\` to recall what happened recently.
  Call \`gc memory append\` to persist an important insight during a session.

OUTPUT
  Human: formatted markdown content
  JSON:  { content: string|null, path: string }`
    )

  memory
    .command("show")
    .description("Show long-term memory (MEMORY.md)")
    .option("--json", "Output as JSON")
    .action((opts) => {
      const format: OutputFormat = opts.json ? "json" : "human"
      try {
        const ws = resolveWorkspace()
        const content = readMemory(ws.root)
        if (!content) {
          printOutput(
            { content: null, path: ws.memoryFile },
            "⚠️  MEMORY.md not found. Run `gc sync from <path>` to import.",
            format
          )
          return
        }
        printOutput({ content, path: ws.memoryFile }, content, format)
      } catch (e) {
        printError(String(e), format)
      }
    })

  memory
    .command("daily [date]")
    .description("Show daily memory (default: today). Format: YYYY-MM-DD")
    .option("--json", "Output as JSON")
    .action((date, opts) => {
      const format: OutputFormat = opts.json ? "json" : "human"
      const today = new Date().toISOString().slice(0, 10)
      const targetDate = date ?? today
      try {
        const ws = resolveWorkspace()
        const content = readDailyMemory(ws.root, targetDate)
        if (!content) {
          printOutput(
            { content: null, date: targetDate },
            `⚠️  No daily memory found for ${targetDate}`,
            format
          )
          return
        }
        printOutput({ content, date: targetDate }, content, format)
      } catch (e) {
        printError(String(e), format)
      }
    })

  memory
    .command("append <text>")
    .description("Append an entry to long-term memory (MEMORY.md)")
    .action((text) => {
      try {
        const ws = resolveWorkspace()
        appendMemory(ws.root, text)
        console.log(`✅ Appended to MEMORY.md: "${text}"`)
      } catch (e) {
        console.error(`❌ ${e}`)
        process.exit(1)
      }
    })
}
