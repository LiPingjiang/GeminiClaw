# GeminiClaw Initial Build Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use super-assistant:subagent-driven-development to implement this plan task-by-task.

**Goal:** Build the complete GeminiClaw `src/` from scratch — config loader, provider adapters, session memory, Fastify HTTP server, and wire everything together.

**Architecture:** Config-driven provider routing with a fallback chain; stateless Fastify routes delegate to ProviderRouter for LLM calls and SessionMemory for conversation history; AnthropicProvider and McliProvider share the same Anthropic SDK with different baseURLs.

**Tech Stack:** TypeScript ESM, Node.js ≥20, Fastify 5, @anthropic-ai/sdk, js-yaml, zod, vitest.

**Execution Config:**
```yaml
confirm_after_each_task: false
skip_spec_review: false
skip_quality_review: false
parallel_tasks: 1
```

---

### Task 1: Project scaffolding — tsconfig + vitest config

**Files:**
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `config.example.yaml`

**Step 1: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 2: Write vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config"
export default defineConfig({ test: { environment: "node" } })
```

**Step 3: Write config.example.yaml**

```yaml
server:
  port: 3000
  host: "0.0.0.0"
  # authToken: "your-secret-token"

providers:
  - name: anthropic
    type: anthropic
    apiKey: "sk-ant-..."
    models:
      - claude-opus-4-6
      - claude-sonnet-4-6

  - name: mcli
    type: mcli
    apiKey: "your-mcli-key"
    baseUrl: "https://your-mcli-endpoint/v1"
    models:
      - mcli-model-default

routing:
  default: "anthropic/claude-sonnet-4-6"
  fallback:
    - "anthropic/claude-sonnet-4-6"
    - "mcli/mcli-model-default"

memory:
  enabled: true
  dataDir: ".data/sessions"
  maxSessionAge: 86400

agent:
  maxTurns: 20
  timeoutSeconds: 60
```

**Step 4: Verify TypeScript can find config**

Run: `pnpm tsc --noEmit 2>&1 | head -5`
Expected: errors only about missing src/ files (no tsconfig errors)

**Step 5: Commit**

```bash
git add tsconfig.json vitest.config.ts config.example.yaml
git commit -m "chore: add tsconfig, vitest config, and config example"
```

---

### Task 2: Config schema + loader

**Files:**
- Create: `src/config/schema.ts`
- Create: `src/config/loader.ts`
- Test: `src/config/loader.test.ts`

**Step 1: Write the failing test**

```typescript
// src/config/loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFileSync, unlinkSync, mkdirSync } from "fs"
import { join } from "path"
import { loadConfig } from "./loader.js"

const TMP = "/tmp/geminiclaw-test"

beforeEach(() => { mkdirSync(TMP, { recursive: true }) })

afterEach(() => {
  try { unlinkSync(join(TMP, "config.yaml")) } catch {}
})

const VALID_YAML = `
server:
  port: 3000
  host: "0.0.0.0"
providers:
  - name: anthropic
    type: anthropic
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
```

**Step 2: Run test to verify it fails**

Run: `pnpm test src/config/loader.test.ts 2>&1 | tail -10`
Expected: FAIL — "Cannot find module './loader.js'"

**Step 3: Write src/config/schema.ts**

```typescript
// src/config/schema.ts
import { z } from "zod"

export const serverConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3000),
  host: z.string().default("0.0.0.0"),
  authToken: z.string().optional(),
})

export const providerTypeSchema = z.enum(["anthropic", "openai", "mcli", "friday"])

export const providerConfigSchema = z.object({
  name: z.string().min(1),
  type: providerTypeSchema,
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  models: z.array(z.string()).min(1),
})

export const routingConfigSchema = z.object({
  default: z.string(),
  fallback: z.array(z.string()).default([]),
})

export const memoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().default(".data/sessions"),
  maxSessionAge: z.number().int().positive().default(86400),
})

export const agentConfigSchema = z.object({
  maxTurns: z.number().int().positive().default(20),
  timeoutSeconds: z.number().int().positive().default(60),
})

export const configSchema = z.object({
  server: serverConfigSchema,
  providers: z.array(providerConfigSchema).min(1),
  routing: routingConfigSchema,
  memory: memoryConfigSchema,
  agent: agentConfigSchema,
})

export type ServerConfig = z.infer<typeof serverConfigSchema>
export type ProviderConfig = z.infer<typeof providerConfigSchema>
export type RoutingConfig = z.infer<typeof routingConfigSchema>
export type MemoryConfig = z.infer<typeof memoryConfigSchema>
export type AgentConfig = z.infer<typeof agentConfigSchema>
export type Config = z.infer<typeof configSchema>
```

**Step 4: Write src/config/loader.ts**

```typescript
// src/config/loader.ts
import { readFileSync } from "fs"
import { resolve } from "path"
import yaml from "js-yaml"
import { configSchema, type Config } from "./schema.js"
import { ZodError } from "zod"

export function loadConfig(configPath?: string): Config {
  const filePath = resolve(configPath ?? process.cwd() + "/config.yaml")

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
```

**Step 5: Run tests to verify they pass**

Run: `pnpm test src/config/loader.test.ts 2>&1 | tail -15`
Expected: 3 tests PASS

**Step 6: Check incremental coverage**

Run: `npx vitest run --coverage src/config/loader.test.ts 2>&1 | tail -20`
Expected: loader.ts ≥ 60% line coverage

**Step 7: Commit**

```bash
git add src/config/schema.ts src/config/loader.ts src/config/loader.test.ts
git commit -m "feat: add config schema and loader with zod validation"
```

---

### Task 3: Provider types + SessionMemory

**Files:**
- Create: `src/providers/types.ts`
- Create: `src/memory/session.ts`
- Test: `src/memory/session.test.ts`

**Step 1: Write failing test for SessionMemory**

```typescript
// src/memory/session.test.ts
import { describe, it, expect, beforeEach } from "vitest"
import { SessionMemory } from "./session.js"

let mem: SessionMemory

beforeEach(() => { mem = new SessionMemory() })

it("returns empty array for unknown session", () => {
  expect(mem.get("unknown")).toEqual([])
})

it("appends and retrieves messages", () => {
  mem.append("s1", { role: "user", content: "hello" })
  mem.append("s1", { role: "assistant", content: "hi" })
  const msgs = mem.get("s1")
  expect(msgs).toHaveLength(2)
  expect(msgs[0].role).toBe("user")
  expect(msgs[1].content).toBe("hi")
})

it("clear removes session messages", () => {
  mem.append("s1", { role: "user", content: "hello" })
  mem.clear("s1")
  expect(mem.get("s1")).toEqual([])
})

it("generateId returns unique UUIDs", () => {
  const a = mem.generateId()
  const b = mem.generateId()
  expect(a).not.toBe(b)
  expect(a).toMatch(/^[0-9a-f-]{36}$/)
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm test src/memory/session.test.ts 2>&1 | tail -10`
Expected: FAIL — "Cannot find module './session.js'"

**Step 3: Write src/providers/types.ts**

```typescript
// src/providers/types.ts
export interface Message {
  role: "user" | "assistant" | "system"
  content: string
}

export interface ChatOptions {
  model?: string
  maxTokens?: number
  temperature?: number
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface ChatResponse {
  content: string
  model: string
  usage?: TokenUsage
}

export interface StreamChunk {
  delta: string
  done: boolean
}

export interface Provider {
  name: string
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse>
  stream(messages: Message[], options?: ChatOptions): AsyncIterable<StreamChunk>
}
```

**Step 4: Write src/memory/session.ts**

```typescript
// src/memory/session.ts
import { randomUUID } from "crypto"
import type { Message } from "../providers/types.js"

export class SessionMemory {
  private sessions: Map<string, Message[]> = new Map()

  get(sessionId: string): Message[] {
    return this.sessions.get(sessionId) ?? []
  }

  append(sessionId: string, message: Message): void {
    const existing = this.sessions.get(sessionId) ?? []
    this.sessions.set(sessionId, [...existing, message])
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  generateId(): string {
    return randomUUID()
  }
}
```

**Step 5: Run tests to verify they pass**

Run: `pnpm test src/memory/session.test.ts 2>&1 | tail -10`
Expected: 4 tests PASS

**Step 6: Check coverage**

Run: `npx vitest run --coverage src/memory/session.test.ts 2>&1 | tail -15`
Expected: session.ts ≥ 60% line coverage

**Step 7: Commit**

```bash
git add src/providers/types.ts src/memory/session.ts src/memory/session.test.ts
git commit -m "feat: add provider types interface and session memory"
```

---

### Task 4: AnthropicProvider + McliProvider

**Files:**
- Create: `src/providers/anthropic.ts`
- Create: `src/providers/mcli.ts`

No test file for this task — providers make real network calls; they are tested via router mock tests in Task 5.

**Step 1: Write src/providers/anthropic.ts**

```typescript
// src/providers/anthropic.ts
import Anthropic from "@anthropic-ai/sdk"
import type { ProviderConfig } from "../config/schema.js"
import type {
  Message,
  ChatOptions,
  ChatResponse,
  StreamChunk,
  Provider,
} from "./types.js"

export class AnthropicProvider implements Provider {
  readonly name: string
  private client: Anthropic
  private defaultModel: string

  constructor(config: ProviderConfig, clientOverride?: Anthropic) {
    this.name = config.name
    this.defaultModel = config.models[0]
    this.client =
      clientOverride ??
      new Anthropic({
        apiKey: config.apiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      })
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const model = options?.model ?? this.defaultModel
    const systemMessages = messages.filter(m => m.role === "system")
    const nonSystemMessages = messages.filter(m => m.role !== "system")

    const response = await this.client.messages.create({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(systemMessages.length > 0
        ? { system: systemMessages.map(m => m.content).join("\n") }
        : {}),
      messages: nonSystemMessages.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    })

    const textBlock = response.content.find(b => b.type === "text")
    const content = textBlock && textBlock.type === "text" ? textBlock.text : ""

    return {
      content,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    }
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    const model = options?.model ?? this.defaultModel
    const systemMessages = messages.filter(m => m.role === "system")
    const nonSystemMessages = messages.filter(m => m.role !== "system")

    const stream = this.client.messages.stream({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(systemMessages.length > 0
        ? { system: systemMessages.map(m => m.content).join("\n") }
        : {}),
      messages: nonSystemMessages.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    })

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield { delta: event.delta.text, done: false }
      }
    }

    yield { delta: "", done: true }
  }
}
```

**Step 2: Write src/providers/mcli.ts**

```typescript
// src/providers/mcli.ts
import Anthropic from "@anthropic-ai/sdk"
import { AnthropicProvider } from "./anthropic.js"
import type { ProviderConfig } from "../config/schema.js"

export class McliProvider extends AnthropicProvider {
  constructor(config: ProviderConfig) {
    const client = new Anthropic({
      apiKey: config.apiKey ?? "mcli",
      baseURL: config.baseUrl,
    })
    super(config, client)
  }
}
```

**Step 3: Verify TypeScript compiles**

Run: `pnpm tsc --noEmit 2>&1 | head -20`
Expected: errors only about missing files not yet written (server/, index.ts)

**Step 4: Commit**

```bash
git add src/providers/anthropic.ts src/providers/mcli.ts
git commit -m "feat: add AnthropicProvider and McliProvider"
```

---

### Task 5: ProviderRouter with fallback

**Files:**
- Create: `src/providers/router.ts`
- Test: `src/providers/router.test.ts`

**Step 1: Write the failing test**

```typescript
// src/providers/router.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { ProviderRouter } from "./router.js"
import type { Provider, Message, ChatResponse } from "./types.js"
import type { RoutingConfig } from "../config/schema.js"

function makeProvider(name: string, fail = false): Provider {
  return {
    name,
    chat: vi.fn().mockImplementation(async () => {
      if (fail) throw new Error(`${name} failed`)
      return { content: `reply from ${name}`, model: "test-model" } satisfies ChatResponse
    }),
    stream: vi.fn().mockImplementation(async function* () { yield { delta: "", done: true } }),
  }
}

const msgs: Message[] = [{ role: "user", content: "hello" }]

it("routes to default provider", async () => {
  const p1 = makeProvider("p1")
  const router = new ProviderRouter([p1], { default: "p1/m1", fallback: ["p1/m1"] })
  const res = await router.chat(msgs)
  expect(res.content).toBe("reply from p1")
  expect(p1.chat).toHaveBeenCalledWith(msgs, { model: "m1" })
})

it("falls back to second provider when first fails", async () => {
  const p1 = makeProvider("p1", true)
  const p2 = makeProvider("p2")
  const router = new ProviderRouter([p1, p2], {
    default: "p1/m1",
    fallback: ["p1/m1", "p2/m2"],
  })
  const res = await router.chat(msgs)
  expect(res.content).toBe("reply from p2")
  expect(p1.chat).toHaveBeenCalledOnce()
  expect(p2.chat).toHaveBeenCalledOnce()
})

it("throws when all providers fail", async () => {
  const p1 = makeProvider("p1", true)
  const router = new ProviderRouter([p1], { default: "p1/m1", fallback: ["p1/m1"] })
  await expect(router.chat(msgs)).rejects.toThrow("All providers failed")
})

it("passes caller options (temperature) to provider", async () => {
  const p1 = makeProvider("p1")
  const router = new ProviderRouter([p1], { default: "p1/m1", fallback: ["p1/m1"] })
  await router.chat(msgs, { temperature: 0.5 })
  expect(p1.chat).toHaveBeenCalledWith(msgs, { model: "m1", temperature: 0.5 })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm test src/providers/router.test.ts 2>&1 | tail -10`
Expected: FAIL — "Cannot find module './router.js'"

**Step 3: Write src/providers/router.ts**

```typescript
// src/providers/router.ts
import type { Provider, Message, ChatOptions, ChatResponse } from "./types.js"
import type { RoutingConfig } from "../config/schema.js"

function parseRoute(route: string): { providerName: string; model: string } {
  const idx = route.indexOf("/")
  if (idx === -1) return { providerName: route, model: route }
  return { providerName: route.slice(0, idx), model: route.slice(idx + 1) }
}

export class ProviderRouter {
  private providers: Map<string, Provider>
  private routing: RoutingConfig

  constructor(providers: Provider[], routing: RoutingConfig) {
    this.providers = new Map(providers.map(p => [p.name, p]))
    this.routing = routing
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const chain = this.routing.fallback.length > 0
      ? this.routing.fallback
      : [this.routing.default]

    const errors: string[] = []

    for (const route of chain) {
      const { providerName, model } = parseRoute(route)
      const provider = this.providers.get(providerName)
      if (!provider) {
        errors.push(`Provider "${providerName}" not found`)
        continue
      }
      try {
        return await provider.chat(messages, { ...options, model })
      } catch (err) {
        errors.push(`${providerName}: ${(err as Error).message}`)
      }
    }

    throw new Error(`All providers failed:\n${errors.join("\n")}`)
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test src/providers/router.test.ts 2>&1 | tail -10`
Expected: 4 tests PASS

**Step 5: Check coverage**

Run: `npx vitest run --coverage src/providers/router.test.ts 2>&1 | tail -15`
Expected: router.ts ≥ 60% line coverage

**Step 6: Commit**

```bash
git add src/providers/router.ts src/providers/router.test.ts
git commit -m "feat: add ProviderRouter with fallback chain"
```

---

### Task 6: Fastify server + health route

**Files:**
- Create: `src/server/routes/health.ts`
- Create: `src/server/index.ts`

**Step 1: Write src/server/routes/health.ts**

```typescript
// src/server/routes/health.ts
import type { FastifyInstance } from "fastify"

export async function healthRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get("/v1/health", async (_request, reply) => {
    return reply.send({ status: "ok", timestamp: new Date().toISOString() })
  })
}
```

**Step 2: Write src/server/index.ts**

```typescript
// src/server/index.ts
import Fastify, { type FastifyInstance } from "fastify"
import type { Config } from "../config/schema.js"
import type { ProviderRouter } from "../providers/router.js"
import type { SessionMemory } from "../memory/session.js"
import { healthRoute } from "./routes/health.js"
import { chatRoute } from "./routes/chat.js"

export async function buildServer(
  config: Config,
  router: ProviderRouter,
  memory: SessionMemory,
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false })

  await fastify.register(healthRoute)
  await fastify.register(chatRoute, {
    router,
    memory,
    authToken: config.server.authToken,
  })

  return fastify
}
```

**Step 3: Verify TypeScript (partial — chat.ts not yet written)**

Run: `pnpm tsc --noEmit 2>&1 | grep -v "chat.ts" | head -20`
Expected: errors only about chat.ts not existing

**Step 4: Commit**

```bash
git add src/server/routes/health.ts src/server/index.ts
git commit -m "feat: add Fastify server scaffold and health route"
```

---

### Task 7: Chat route with auth

**Files:**
- Create: `src/server/routes/chat.ts`
- Test: `src/server/routes/chat.test.ts`

**Step 1: Write the failing test**

```typescript
// src/server/routes/chat.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildServer } from "../index.js"
import type { ProviderRouter } from "../../providers/router.js"
import type { SessionMemory } from "../../memory/session.js"
import type { Config } from "../../config/schema.js"

function makeConfig(authToken?: string): Config {
  return {
    server: { port: 3000, host: "0.0.0.0", authToken },
    providers: [{ name: "p1", type: "anthropic", models: ["m1"] }],
    routing: { default: "p1/m1", fallback: ["p1/m1"] },
    memory: { enabled: true, dataDir: ".data", maxSessionAge: 3600 },
    agent: { maxTurns: 10, timeoutSeconds: 30 },
  }
}

function makeRouter(): ProviderRouter {
  return {
    chat: vi.fn().mockResolvedValue({ content: "pong", model: "m1" }),
  } as unknown as ProviderRouter
}

function makeMemory(): SessionMemory {
  const store: Record<string, unknown[]> = {}
  return {
    get: vi.fn((id: string) => store[id] ?? []),
    append: vi.fn((id: string, msg: unknown) => { store[id] = [...(store[id] ?? []), msg] }),
    clear: vi.fn(),
    generateId: vi.fn(() => "test-session-id"),
  } as unknown as SessionMemory
}

it("returns 401 when authToken is set and no header provided", async () => {
  const app = await buildServer(makeConfig("secret"), makeRouter(), makeMemory())
  const res = await app.inject({ method: "POST", url: "/v1/agent/chat", payload: { message: "hi" } })
  expect(res.statusCode).toBe(401)
})

it("returns 401 when authToken is set and wrong token provided", async () => {
  const app = await buildServer(makeConfig("secret"), makeRouter(), makeMemory())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    headers: { authorization: "Bearer wrong" },
    payload: { message: "hi" },
  })
  expect(res.statusCode).toBe(401)
})

it("returns response when no authToken configured", async () => {
  const router = makeRouter()
  const app = await buildServer(makeConfig(), router, makeMemory())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "ping" },
  })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body)
  expect(body.response).toBe("pong")
  expect(body.sessionId).toBe("test-session-id")
})

it("returns response when correct bearer token provided", async () => {
  const router = makeRouter()
  const app = await buildServer(makeConfig("secret"), router, makeMemory())
  const res = await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    headers: { authorization: "Bearer secret" },
    payload: { message: "ping" },
  })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body)
  expect(body.response).toBe("pong")
})

it("uses existing sessionId from request body", async () => {
  const router = makeRouter()
  const memory = makeMemory()
  const app = await buildServer(makeConfig(), router, memory)
  await app.inject({
    method: "POST",
    url: "/v1/agent/chat",
    payload: { message: "hello", sessionId: "existing-id" },
  })
  expect(memory.get).toHaveBeenCalledWith("existing-id")
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm test src/server/routes/chat.test.ts 2>&1 | tail -10`
Expected: FAIL — missing chat route

**Step 3: Write src/server/routes/chat.ts**

```typescript
// src/server/routes/chat.ts
import type { FastifyInstance } from "fastify"
import type { ProviderRouter } from "../../providers/router.js"
import type { SessionMemory } from "../../memory/session.js"

interface ChatBody {
  message: string
  sessionId?: string
  model?: string
}

interface ChatRouteOpts {
  router: ProviderRouter
  memory: SessionMemory
  authToken?: string
}

export async function chatRoute(
  fastify: FastifyInstance,
  opts: ChatRouteOpts,
): Promise<void> {
  fastify.post<{ Body: ChatBody }>("/v1/agent/chat", async (request, reply) => {
    if (opts.authToken) {
      const auth = request.headers["authorization"]
      if (!auth || auth !== `Bearer ${opts.authToken}`) {
        return reply.status(401).send({ error: "Unauthorized" })
      }
    }

    const { message, sessionId, model } = request.body
    const sid = sessionId ?? opts.memory.generateId()
    const history = opts.memory.get(sid)

    opts.memory.append(sid, { role: "user", content: message })

    const messages = [...history, { role: "user" as const, content: message }]
    const chatResponse = await opts.router.chat(messages, model ? { model } : undefined)

    opts.memory.append(sid, { role: "assistant", content: chatResponse.content })

    return reply.send({
      response: chatResponse.content,
      sessionId: sid,
      model: chatResponse.model,
    })
  })
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test src/server/routes/chat.test.ts 2>&1 | tail -10`
Expected: 5 tests PASS

**Step 5: Check coverage**

Run: `npx vitest run --coverage src/server/routes/chat.test.ts 2>&1 | tail -15`
Expected: chat.ts ≥ 60% line coverage

**Step 6: Commit**

```bash
git add src/server/routes/chat.ts src/server/routes/chat.test.ts
git commit -m "feat: add chat route with bearer auth and session memory"
```

---

### Task 8: Entry point + provider factory

**Files:**
- Create: `src/index.ts`

**Step 1: Write src/index.ts**

```typescript
// src/index.ts
import { loadConfig } from "./config/loader.js"
import { AnthropicProvider } from "./providers/anthropic.js"
import { McliProvider } from "./providers/mcli.js"
import { ProviderRouter } from "./providers/router.js"
import { SessionMemory } from "./memory/session.js"
import { buildServer } from "./server/index.js"
import type { Provider } from "./providers/types.js"
import type { ProviderConfig } from "./config/schema.js"

function buildProvider(config: ProviderConfig): Provider {
  switch (config.type) {
    case "anthropic":
      return new AnthropicProvider(config)
    case "mcli":
      return new McliProvider(config)
    default:
      throw new Error(`Unsupported provider type: ${config.type}`)
  }
}

async function main(): Promise<void> {
  const config = loadConfig()

  const providers = config.providers.map(buildProvider)
  const router = new ProviderRouter(providers, config.routing)
  const memory = new SessionMemory()

  const server = await buildServer(config, router, memory)

  await server.listen({ port: config.server.port, host: config.server.host })
  console.log(`GeminiClaw listening on ${config.server.host}:${config.server.port}`)
}

main().catch(err => {
  console.error("Fatal error:", err)
  process.exit(1)
})
```

**Step 2: Build the full project**

Run: `pnpm build 2>&1`
Expected: exit 0, dist/ directory created

**Step 3: Run all tests**

Run: `pnpm test 2>&1`
Expected: All tests pass (config, memory, router, chat)

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add entry point wiring config, providers, server"
```

---

### Task 9: Final verification

**Step 1: Full clean build**

Run: `rm -rf dist && pnpm build 2>&1`
Expected: exit 0

**Step 2: All tests pass**

Run: `pnpm test 2>&1`
Expected: all suites green

**Step 3: Install pnpm lock (if missing)**

Run: `pnpm install 2>&1 | tail -5`
Expected: packages locked

**Step 4: Final commit**

```bash
git add pnpm-lock.yaml
git commit -m "chore: lock pnpm dependencies"
```
