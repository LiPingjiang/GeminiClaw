import { readFileSync, existsSync } from "fs"
import { resolve, join } from "path"
import os from "os"
import yaml from "js-yaml"
import { configSchema, type Config } from "./schema.js"
import { ZodError } from "zod"

export function loadConfig(configPath?: string): Config {
  // 配置查找顺序：显式参数 → 环境变量 → ~/.gemeniclaw/config.yaml → 代码目录
  const userConfigPath = join(os.homedir(), '.gemeniclaw', 'config.yaml')
  const defaultPath = existsSync(userConfigPath)
    ? userConfigPath
    : process.cwd() + '/config.yaml'
  const filePath = resolve(configPath ?? process.env.GEMINICLAW_CONFIG ?? defaultPath)

  let raw: string
  try {
    raw = readFileSync(filePath, "utf-8")
  } catch (err) {
    throw new Error(`Failed to read config file at ${filePath}: ${(err as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch (err) {
    throw new Error(`Failed to parse YAML in ${filePath}: ${(err as Error).message}`)
  }

  // Allow PORT env var to override server.port (used by Level 2 validator for temporary process)
  if (process.env.PORT) {
    const port = parseInt(process.env.PORT, 10)
    if (!isNaN(port) && typeof parsed === "object" && parsed !== null) {
      const p = parsed as Record<string, unknown>
      p.server = { ...(typeof p.server === "object" && p.server !== null ? p.server as object : {}), port }
    }
  }

  try {
    return configSchema.parse(parsed)
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map(i => `  ${i.path.join(".")}: ${i.message}`).join("\n")
      throw new Error(`Invalid config in ${filePath}:\n${issues}`)
    }
    throw err
  }
}
