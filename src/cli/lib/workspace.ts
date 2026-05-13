import { existsSync, readFileSync } from "fs"
import { join, resolve, dirname } from "path"
import yaml from "js-yaml"

export interface WorkspacePaths {
  root: string
  soulFile: string
  userFile: string
  identityFile: string
  memoryFile: string
  agentsFile: string
  toolsFile: string
  memoryDir: string
  skillsDir: string
}

export function resolveWorkspace(): WorkspacePaths {
  const configPath = findConfigFile()
  const projectRoot = dirname(configPath)

  let workspaceDir = ".workspace"
  let skillsDir = "skills"

  try {
    const raw = yaml.load(readFileSync(configPath, "utf-8")) as any
    workspaceDir = raw?.workspace?.dir ?? ".workspace"
    skillsDir = raw?.skills?.dir ?? "skills"
  } catch {
    // use defaults
  }

  const root = resolve(projectRoot, workspaceDir)
  const skillsDirAbs = resolve(projectRoot, skillsDir)

  return {
    root,
    soulFile: join(root, "SOUL.md"),
    userFile: join(root, "USER.md"),
    identityFile: join(root, "IDENTITY.md"),
    memoryFile: join(root, "MEMORY.md"),
    agentsFile: join(root, "AGENTS.md"),
    toolsFile: join(root, "TOOLS.md"),
    memoryDir: join(root, "memory"),
    skillsDir: skillsDirAbs,
  }
}

function findConfigFile(): string {
  if (process.env.GC_CONFIG) return resolve(process.env.GC_CONFIG)

  const cwd = join(process.cwd(), "config.yaml")
  if (existsSync(cwd)) return cwd

  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, "package.json")
    if (existsSync(pkg)) {
      try {
        const p = JSON.parse(readFileSync(pkg, "utf-8"))
        if (p.name === "geminiclaw") {
          const cfg = join(dir, "config.yaml")
          if (existsSync(cfg)) return cfg
        }
      } catch {}
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  throw new Error(
    "config.yaml not found. Set GC_CONFIG env var or run from GeminiClaw project directory."
  )
}
