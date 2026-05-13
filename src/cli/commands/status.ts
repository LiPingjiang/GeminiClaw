import { Command } from "commander"
import { existsSync, readFileSync } from "fs"
import { join, resolve, dirname } from "path"
import { execSync } from "child_process"
import yaml from "js-yaml"
import { printOutput, printError, type OutputFormat } from "../lib/output.js"
import { resolveWorkspace } from "../lib/workspace.js"
import { SkillLoader } from "../../skills/loader-full.js"
import { SkillRegistry } from "../lib/skill-registry.js"

interface StatusResult {
  ok: boolean
  version: string
  config: { found: boolean; path: string | null }
  workspace: { found: boolean; path: string | null; files: Record<string, boolean> }
  skills: { count: number; registered: number; unregistered: number }
  server: { running: boolean; port: number | null; pid: number | null }
  git: { branch: string | null; commit: string | null; dirty: boolean }
}

function findConfigFile(): string | null {
  if (process.env.GC_CONFIG) return resolve(process.env.GC_CONFIG)
  const cwd = process.cwd() + "/config.yaml"
  if (existsSync(cwd)) return cwd
  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
    const pkg = dir + "/package.json"
    if (existsSync(pkg)) {
      try {
        const p = JSON.parse(readFileSync(pkg, "utf-8"))
        if (p.name === "geminiclaw") {
          const cfg = dir + "/config.yaml"
          if (existsSync(cfg)) return cfg
        }
      } catch {}
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function getVersion(): string {
  try {
    const pkgPath = join(process.cwd(), "package.json")
    if (existsSync(pkgPath)) {
      return JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? "unknown"
    }
  } catch {}
  return "unknown"
}

function getGitInfo(): { branch: string | null; commit: string | null; dirty: boolean } {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim()
    const commit = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim()
    const status = execSync("git status --porcelain", { encoding: "utf-8" }).trim()
    return { branch, commit, dirty: status.length > 0 }
  } catch {
    return { branch: null, commit: null, dirty: false }
  }
}

function checkServer(port: number): { running: boolean; pid: number | null } {
  try {
    const out = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`, { encoding: "utf-8" }).trim()
    if (out) {
      return { running: true, pid: parseInt(out.split("\n")[0]) }
    }
  } catch {}
  return { running: false, pid: null }
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description(
      `System status — check if GeminiClaw is configured and running correctly

WHAT
  Checks config.yaml, workspace files, installed skills, server process, and git state.
  Returns an overall OK/FAIL indicator plus per-component details.

WHEN (agent guidance)
  Call this at session start to verify the environment is healthy.
  Call this when troubleshooting unexpected behavior.
  Call this before running gc sync to confirm the destination is ready.

OUTPUT
  Human: colored status report with ✅/⚠️/❌ indicators
  JSON:  structured status object with ok:boolean`
    )
    .option("--json", "Output as JSON")
    .action((opts) => {
      const format: OutputFormat = opts.json ? "json" : "human"
      try {
        const version = getVersion()
        const configPath = findConfigFile()

        let serverPort = 3000
        if (configPath) {
          try {
            const raw = yaml.load(readFileSync(configPath, "utf-8")) as any
            serverPort = raw?.server?.port ?? 3000
          } catch {}
        }

        let workspacePath: string | null = null
        let workspaceFiles: Record<string, boolean> = {}
        let skillCount = 0
        let registeredCount = 0

        try {
          const ws = resolveWorkspace()
          workspacePath = ws.root
          workspaceFiles = {
            "SOUL.md": existsSync(ws.soulFile),
            "USER.md": existsSync(ws.userFile),
            "IDENTITY.md": existsSync(ws.identityFile),
            "MEMORY.md": existsSync(ws.memoryFile),
            "AGENTS.md": existsSync(ws.agentsFile),
          }
          const skills = SkillLoader.loadSkills(ws.skillsDir)
          skillCount = skills.length
          const registry = new SkillRegistry(ws.skillsDir)
          registeredCount = registry.list().length
        } catch {}

        const serverInfo = checkServer(serverPort)
        const gitInfo = getGitInfo()

        const result: StatusResult = {
          ok: !!configPath,
          version,
          config: { found: !!configPath, path: configPath },
          workspace: {
            found: !!workspacePath,
            path: workspacePath,
            files: workspaceFiles,
          },
          skills: {
            count: skillCount,
            registered: registeredCount,
            unregistered: skillCount - registeredCount,
          },
          server: { running: serverInfo.running, port: serverPort, pid: serverInfo.pid },
          git: gitInfo,
        }

        const lines: string[] = [
          `GeminiClaw v${version} — ${result.ok ? "✅ OK" : "❌ NEEDS SETUP"}`,
          "",
          `Config:    ${result.config.found ? `✅ ${result.config.path}` : "❌ config.yaml not found"}`,
          `Workspace: ${result.workspace.found ? `✅ ${result.workspace.path}` : "⚠️  not configured"}`,
        ]

        if (Object.keys(workspaceFiles).length > 0) {
          for (const [file, exists] of Object.entries(workspaceFiles)) {
            lines.push(`  ${exists ? "✅" : "⚠️ "} ${file}`)
          }
        }

        lines.push(
          `Skills:    ${skillCount} installed, ${registeredCount} with provenance${skillCount - registeredCount > 0 ? `, ${skillCount - registeredCount} unregistered` : ""}`,
          `Server:    ${serverInfo.running ? `✅ running on :${serverPort} (pid ${serverInfo.pid})` : `⚠️  not running on :${serverPort}`}`,
          `Git:       ${gitInfo.branch ? `${gitInfo.branch} @ ${gitInfo.commit}${gitInfo.dirty ? " (dirty)" : ""}` : "not a git repo"}`,
        )

        if (!result.config.found) {
          lines.push("", "Run from GeminiClaw project directory or set GC_CONFIG env var.")
        }
        if (!result.workspace.found || Object.values(workspaceFiles).some((v) => !v)) {
          lines.push("", "Run `gc sync from <openclaw-workspace-path>` to import identity and memory.")
        }

        printOutput(result, lines.join("\n"), format)
      } catch (e) {
        printError(String(e), format)
      }
    })
}
