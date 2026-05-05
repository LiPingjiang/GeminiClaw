import { readFileSync } from "fs"
import { resolve } from "path"
import yaml from "js-yaml"
import { configSchema, type Config } from "./schema.js"
import { ZodError } from "zod"

export function loadConfig(configPath?: string): Config {
  const filePath = resolve(
    configPath ?? process.env.GEMINICLAW_CONFIG ?? process.cwd() + "/config.yaml"
  )

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
