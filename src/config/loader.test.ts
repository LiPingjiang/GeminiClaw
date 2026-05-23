import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFileSync, unlinkSync, mkdirSync } from "fs"
import { join } from "path"
import { loadConfig } from "./loader.js"
import { configSchema } from "./schema.js"

const TMP = "/tmp/geminiclaw-test"

let savedPort: string | undefined

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
  // Isolate from any PORT env var set by the parent process (e.g. Level 2 validator)
  savedPort = process.env.PORT
  delete process.env.PORT
})

afterEach(() => {
  try { unlinkSync(join(TMP, "config.yaml")) } catch {}
  // Restore PORT env var
  if (savedPort !== undefined) process.env.PORT = savedPort
  else delete process.env.PORT
})

const VALID_YAML = `
server:
  port: 3000
  host: "0.0.0.0"
providers:
  - name: anthropic
    api: anth-messages
    apiKey: sk-test
    models:
      - claude-sonnet-4-6
routing:
  default: "anthropic/claude-sonnet-4-6"
  fallback:
    - "anthropic/claude-sonnet-4-6"
memory:
  enabled: true
  dataDir: ".data"
  maxSessionAge: 3600
agent:
  maxTurns: 10
  timeoutSeconds: 30
`

it("loads a valid config file", () => {
  writeFileSync(join(TMP, "config.yaml"), VALID_YAML)
  const config = loadConfig(join(TMP, "config.yaml"))
  expect(config.server.port).toBe(3000)
  expect(config.providers[0].name).toBe("anthropic")
  expect(config.routing.default).toBe("anthropic/claude-sonnet-4-6")
})

it("throws on missing file", () => {
  expect(() => loadConfig("/nonexistent/config.yaml")).toThrow()
})

it("throws on invalid yaml structure", () => {
  writeFileSync(join(TMP, "config.yaml"), "server: invalid_not_an_object: 123\n")
  expect(() => loadConfig(join(TMP, "config.yaml"))).toThrow()
})

it("parses workspace config with defaults", () => {
  const raw = {
    server: { port: 3000 },
    providers: [{ name: "mcli", api: "anth-messages", apiKey: "k", models: ["m"] }],
    routing: { default: "mcli/m" },
    memory: { strategy: "buffer" },
    agent: {},
  }
  const config = configSchema.parse(raw)
  expect(config.workspace.dir).toBe(".workspace")
  expect(config.skills.dir).toBe("skills")
})
