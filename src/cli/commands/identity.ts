import { Command } from "commander"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { resolveWorkspace } from "../lib/workspace.js"
import { printOutput, printError, type OutputFormat } from "../lib/output.js"

export interface IdentityFiles {
  soul: string | null
  user: string | null
  identity: string | null
}

export function readIdentityFiles(workspaceRoot: string): IdentityFiles {
  const read = (filename: string): string | null => {
    const p = join(workspaceRoot, filename)
    return existsSync(p) ? readFileSync(p, "utf-8") : null
  }
  return {
    soul: read("SOUL.md"),
    user: read("USER.md"),
    identity: read("IDENTITY.md"),
  }
}

export function registerIdentityCommand(program: Command): void {
  const identity = program
    .command("identity")
    .description(
      `Identity management — who is this agent and who does it serve

WHAT
  Reads SOUL.md, USER.md, and IDENTITY.md from the workspace directory.
  These files define the agent's persona, values, and the human it assists.

WHEN (agent guidance)
  Call this at session start to understand your own identity and context.
  Call this when asked "who are you" or "what are your values".
  Call this before making decisions that require understanding your role.

OUTPUT
  Human: formatted sections for each file
  JSON:  { soul: string|null, user: string|null, identity: string|null }`
    )

  identity
    .command("show")
    .description("Show agent identity files (SOUL.md, USER.md, IDENTITY.md)")
    .option("--json", "Output as JSON")
    .action((opts) => {
      const format: OutputFormat = opts.json ? "json" : "human"
      try {
        const ws = resolveWorkspace()
        const files = readIdentityFiles(ws.root)

        const humanText = [
          files.soul
            ? `## 🧠 SOUL (who I am)\n\n${files.soul}`
            : "⚠️  SOUL.md not found — run `gc sync from <path>` to import",
          files.user
            ? `\n## 👤 USER (who I serve)\n\n${files.user}`
            : "\n⚠️  USER.md not found",
          files.identity
            ? `\n## 🪪 IDENTITY\n\n${files.identity}`
            : "",
        ]
          .filter(Boolean)
          .join("\n")

        printOutput(files, humanText, format)
      } catch (e) {
        printError(String(e), format)
      }
    })
}
