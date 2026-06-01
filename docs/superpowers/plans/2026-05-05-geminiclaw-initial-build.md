# GeminiClaw Initial Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete GeminiClaw agent runtime from scratch: config loader, provider adapters (Anthropic + llm-gw), Fastify HTTP server with `/v1/agent/chat` and `/v1/health`, in-memory session store, and wire everything in `src/index.ts`.

**Architecture:** TypeScript ESM project using Fastify for HTTP, js-yaml + zod for config validation, and @anth-ai/sdk for the Anthropic provider. Providers implement a common `Provider` interface; the server routes requests through the config-driven routing table with ordered fallback. Memory is in-memory with a simple session map (file persistence deferred).

**Tech Stack:** TypeScript 5, Node.js 20 ESM, Fastify 5, Vitest, pnpm, @anth-ai/sdk, js-yaml, zod

---

## File Map

```
src/
├── index.ts                        ← entry: starts server, loads config
├── config/
│   ├── schema.ts                   ← zod schema for config.yaml shape
│   ├── loader.ts                   ← reads config.yaml, validates, returns typed Config
│   └── types.ts                    ← exported Config type (re-exported from schema)
├── providers/
│   ├── types.ts                    ← Provider interface, Message, ChatOptions, ChatResponse, StreamChunk
│   ├── anth.ts                ← AnthropicProvider implements Provider
│   ├── llm-gw.ts                     ← McliProvider implements Provider (OpenAI-compatible API)
│   └── registry.ts                 ← buildProviderRegistry(config) → Map<name, Provider>
├── memory/
│   ├── types.ts                    ← Session, SessionStore interface
│   └── store.ts                    ← InMemorySessionStore implements SessionStore
└── server/
    ├── app.ts                      ← buildApp(deps) → FastifyInstance
    ├── routes/
    │   ├── health.ts               ← GET /v1/health
    │   └── chat.ts                 ← POST /v1/agent/chat
    └── auth.ts                     ← Bearer token auth hook

tests/
├── config/
│   └── loader.test.ts
├── providers/
│   ├── anth.test.ts
│   └── llm-gw.test.ts
├── memory/
│   └── store.test.ts
└── server/
    ├── health.test.ts
    └── chat.test.ts
```

Additionally:
- `tsconfig.json` — TypeScript config (ESM, strict, outDir: dist)

---

## Task 1: TypeScript Config

**Files:**
- Create: `tsconfig.json`

- [ ] **Step 1: Write tsconfig.json**

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
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 2: Verify TypeScript compiles (empty src/ is fine)**

```bash
pnpm build
```

Expected: exit 0 (or "no input files" error — both are fine before src/ has files)

- [ ] **Step 3: Commit**

```bash
git add tsconfig.json
git commit -m "chore: add tsconfig for ESM TypeScript build"
```

---

## Task 2: Config Schema and Loader

**Files:**
- Create: `src/config/types.ts`
- Create: `src/config/schema.ts`
- Create: `src/config/loader.ts`
- Create: `tests/config/loader.test.ts`
- Create: `tests/fixtures/config.test.yaml` (test fixture)

- [ ] **Step 1: Write the failing test**

Create `tests/config/loader.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../../src/config/loader.js'

const TMP = join(import.meta.dirname, '__tmp__')

const VALID_YAML = `
server:
  port: 18888
  host: "127.0.0.1"
  authToken: "test-token"

providers:
  - name: anth
    type: anth
    apiKey: "sk-ant-test"
    models:
      - claude-opus-4

routing:
  default: "anth/claude-opus-4"
  fallback: []

memory:
  enabled: true
  dataDir: "./data/memory"
  maxSessionAge: 86400

agent:
  maxTurns: 50
  timeoutSeconds: 300
`

describe('loadConfig', () => {
  beforeAll(() => mkdirSync(TMP, { recursive: true }))
  afterAll(() => rmSync(TMP, { recursive: true, force: true }))

  it('loads and validates a valid config file', async () => {
    const path = join(TMP, 'valid.yaml')
    writeFileSync(path, VALID_YAML)
    const config = await loadConfig(path)
    expect(config.server.port).toBe(18888)
    expect(config.server.authToken).toBe('test-token')
    expect(config.providers).toHaveLength(1)
    expect(config.providers[0].name).toBe('anth')
    expect(config.routing.default).toBe('anth/claude-opus-4')
    expect(config.memory.enabled).toBe(true)
    expect(config.agent.maxTurns).toBe(50)
  })

  it('throws when file does not exist', async () => {
    await expect(loadConfig(join(TMP, 'missing.yaml'))).rejects.toThrow()
  })

  it('throws when required field is missing', async () => {
    const path = join(TMP, 'invalid.yaml')
    writeFileSync(path, 'server:\n  port: 3000\n')
    await expect(loadConfig(path)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test tests/config/loader.test.ts
```

Expected: FAIL with "Cannot find module '../../src/config/loader.js'"

- [ ] **Step 3: Write types**

Create `src/config/types.ts`:

```typescript
export interface ProviderConfig {
  name: string
  type: 'anth' | 'openai' | 'llm-gw' | 'friday'
  apiKey?: string
  baseUrl?: string
  models: string[]
}

export interface Config {
  server: {
    port: number
    host: string
    authToken: string
  }
  providers: ProviderConfig[]
  routing: {
    default: string
    fallback: string[]
  }
  memory: {
    enabled: boolean
    dataDir: string
    maxSessionAge: number
  }
  agent: {
    maxTurns: number
    timeoutSeconds: number
  }
}
```

- [ ] **Step 4: Write schema**

Create `src/config/schema.ts`:

```typescript
import { z } from 'zod'

export const ProviderConfigSchema = z.object({
  name: z.string(),
  type: z.enum(['anth', 'openai', 'llm-gw', 'friday']),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  models: z.array(z.string()),
})

export const ConfigSchema = z.object({
  server: z.object({
    port: z.number().int().positive(),
    host: z.string(),
    authToken: z.string(),
  }),
  providers: z.array(ProviderConfigSchema),
  routing: z.object({
    default: z.string(),
    fallback: z.array(z.string()),
  }),
  memory: z.object({
    enabled: z.boolean(),
    dataDir: z.string(),
    maxSessionAge: z.number().int().positive(),
  }),
  agent: z.object({
    maxTurns: z.number().int().positive(),
    timeoutSeconds: z.number().int().positive(),
  }),
})
```

- [ ] **Step 5: Write loader**

Create `src/config/loader.ts`:

```typescript
import { readFile } from 'node:fs/promises'
import { load } from 'js-yaml'
import { ConfigSchema } from './schema.js'
import type { Config } from './types.js'

export async function loadConfig(filePath: string): Promise<Config> {
  const raw = await readFile(filePath, 'utf-8')
  const parsed = load(raw)
  return ConfigSchema.parse(parsed) as Config
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
pnpm test tests/config/loader.test.ts
```

Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add src/config/ tests/config/
git commit -m "feat: config loader with zod validation"
```

---

## Task 3: Provider Types and Interface

**Files:**
- Create: `src/providers/types.ts`

- [ ] **Step 1: Write provider types**

Create `src/providers/types.ts`:

```typescript
export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface ChatOptions {
  model: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
}

export interface ChatResponse {
  content: string
  model: string
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

export interface StreamChunk {
  delta: string
  done: boolean
}

export interface Provider {
  name: string
  chat(messages: Message[], options: ChatOptions): Promise<ChatResponse>
  stream(messages: Message[], options: ChatOptions): AsyncIterable<StreamChunk>
}
```

- [ ] **Step 2: Verify types compile**

```bash
pnpm build
```

Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add src/providers/types.ts
git commit -m "feat: provider interface and message types"
```

---

## Task 4: Anthropic Provider

**Files:**
- Create: `src/providers/anth.ts`
- Create: `tests/providers/anth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/providers/anth.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AnthropicProvider } from '../../src/providers/anth.js'
import type { Message, ChatOptions } from '../../src/providers/types.js'

// Mock the Anthropic SDK
vi.mock('@anth-ai/sdk', () => {
  const mockCreate = vi.fn()
  const mockStream = vi.fn()
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: mockCreate,
        stream: mockStream,
      },
    })),
    __mockCreate: mockCreate,
    __mockStream: mockStream,
  }
})

describe('AnthropicProvider', () => {
  it('has correct name', () => {
    const provider = new AnthropicProvider('sk-ant-test', ['claude-opus-4'])
    expect(provider.name).toBe('anth')
  })

  it('chat() returns a ChatResponse', async () => {
    const { __mockCreate } = await import('@anth-ai/sdk') as any
    __mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Hello!' }],
      model: 'claude-opus-4',
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    const provider = new AnthropicProvider('sk-ant-test', ['claude-opus-4'])
    const messages: Message[] = [{ role: 'user', content: 'Hi' }]
    const options: ChatOptions = { model: 'claude-opus-4', maxTokens: 1024 }
    const response = await provider.chat(messages, options)

    expect(response.content).toBe('Hello!')
    expect(response.model).toBe('claude-opus-4')
    expect(response.usage.inputTokens).toBe(10)
    expect(response.usage.outputTokens).toBe(5)
  })

  it('chat() extracts text from multi-block response', async () => {
    const { __mockCreate } = await import('@anth-ai/sdk') as any
    __mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'Part 1 ' },
        { type: 'text', text: 'Part 2' },
      ],
      model: 'claude-opus-4',
      usage: { input_tokens: 5, output_tokens: 3 },
    })

    const provider = new AnthropicProvider('sk-ant-test', ['claude-opus-4'])
    const response = await provider.chat(
      [{ role: 'user', content: 'Hi' }],
      { model: 'claude-opus-4' }
    )
    expect(response.content).toBe('Part 1 Part 2')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test tests/providers/anth.test.ts
```

Expected: FAIL with "Cannot find module '../../src/providers/anth.js'"

- [ ] **Step 3: Implement AnthropicProvider**

Create `src/providers/anth.ts`:

```typescript
import Anthropic from '@anth-ai/sdk'
import type { Provider, Message, ChatOptions, ChatResponse, StreamChunk } from './types.js'

export class AnthropicProvider implements Provider {
  readonly name = 'anth'
  private client: Anthropic

  constructor(
    apiKey: string,
    private readonly models: string[]
  ) {
    this.client = new Anthropic({ apiKey })
  }

  async chat(messages: Message[], options: ChatOptions): Promise<ChatResponse> {
    const anthMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const systemMessage = messages.find(m => m.role === 'system')?.content
      ?? options.systemPrompt

    const response = await this.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      ...(systemMessage ? { system: systemMessage } : {}),
      messages: anthMessages,
    })

    const content = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as { type: 'text'; text: string }).text)
      .join('')

    return {
      content,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    }
  }

  async *stream(messages: Message[], options: ChatOptions): AsyncIterable<StreamChunk> {
    const anthMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const systemMessage = messages.find(m => m.role === 'system')?.content
      ?? options.systemPrompt

    const stream = await this.client.messages.stream({
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      ...(systemMessage ? { system: systemMessage } : {}),
      messages: anthMessages,
    })

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield { delta: event.delta.text, done: false }
      }
    }
    yield { delta: '', done: true }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test tests/providers/anth.test.ts
```

Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/anth.ts tests/providers/anth.test.ts
git commit -m "feat: AnthropicProvider with chat and stream"
```

---

## Task 5: llm-gw Provider

**Files:**
- Create: `src/providers/llm-gw.ts`
- Create: `tests/providers/llm-gw.test.ts`

The llm-gw provider uses an OpenAI-compatible HTTP API. We use `fetch` directly (no extra dependency).

- [ ] **Step 1: Write the failing test**

Create `tests/providers/llm-gw.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { McliProvider } from '../../src/providers/llm-gw.js'
import type { Message, ChatOptions } from '../../src/providers/types.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

afterEach(() => vi.resetAllMocks())

describe('McliProvider', () => {
  it('has correct name', () => {
    const p = new McliProvider('https://llm-gw.example.com', 'token', ['model-a'])
    expect(p.name).toBe('llm-gw')
  })

  it('chat() calls the OpenAI-compatible endpoint and returns ChatResponse', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Hi there!' } }],
        model: 'claude-sonnet-4-6',
        usage: { prompt_tokens: 8, completion_tokens: 4 },
      }),
    })

    const provider = new McliProvider('https://llm-gw.example.com', 'token', ['claude-sonnet-4-6'])
    const messages: Message[] = [{ role: 'user', content: 'Hello' }]
    const options: ChatOptions = { model: 'claude-sonnet-4-6' }
    const response = await provider.chat(messages, options)

    expect(response.content).toBe('Hi there!')
    expect(response.model).toBe('claude-sonnet-4-6')
    expect(response.usage.inputTokens).toBe(8)
    expect(response.usage.outputTokens).toBe(4)

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://llm-gw.example.com/v1/chat/completions')
    expect(JSON.parse(init.body).model).toBe('claude-sonnet-4-6')
  })

  it('chat() throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })

    const provider = new McliProvider('https://llm-gw.example.com', 'bad-token', ['m'])
    await expect(
      provider.chat([{ role: 'user', content: 'x' }], { model: 'm' })
    ).rejects.toThrow('llm-gw API error 401')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test tests/providers/llm-gw.test.ts
```

Expected: FAIL with "Cannot find module '../../src/providers/llm-gw.js'"

- [ ] **Step 3: Implement McliProvider**

Create `src/providers/llm-gw.ts`:

```typescript
import type { Provider, Message, ChatOptions, ChatResponse, StreamChunk } from './types.js'

export class McliProvider implements Provider {
  readonly name = 'llm-gw'

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly models: string[]
  ) {}

  async chat(messages: Message[], options: ChatOptions): Promise<ChatResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`
    const body = {
      model: options.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: options.maxTokens ?? 4096,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`llm-gw API error ${res.status}: ${text}`)
    }

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>
      model: string
      usage: { prompt_tokens: number; completion_tokens: number }
    }

    return {
      content: data.choices[0].message.content,
      model: data.model,
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
    }
  }

  async *stream(messages: Message[], options: ChatOptions): AsyncIterable<StreamChunk> {
    const url = `${this.baseUrl}/v1/chat/completions`
    const body = {
      model: options.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`llm-gw API error ${res.status}: ${text}`)
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const lines = decoder.decode(value).split('\n')
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          yield { delta: '', done: true }
          return
        }
        try {
          const parsed = JSON.parse(data) as {
            choices: Array<{ delta?: { content?: string } }>
          }
          const delta = parsed.choices[0]?.delta?.content ?? ''
          if (delta) yield { delta, done: false }
        } catch {
          // skip malformed SSE lines
        }
      }
    }
    yield { delta: '', done: true }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test tests/providers/llm-gw.test.ts
```

Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/llm-gw.ts tests/providers/llm-gw.test.ts
git commit -m "feat: McliProvider using OpenAI-compatible API"
```

---

## Task 6: Provider Registry

**Files:**
- Create: `src/providers/registry.ts`

- [ ] **Step 1: Write the registry**

Create `src/providers/registry.ts`:

```typescript
import { AnthropicProvider } from './anth.js'
import { McliProvider } from './llm-gw.js'
import type { Provider } from './types.js'
import type { Config, ProviderConfig } from '../config/types.js'

function buildProvider(cfg: ProviderConfig): Provider {
  switch (cfg.type) {
    case 'anth':
      return new AnthropicProvider(cfg.apiKey!, cfg.models)
    case 'llm-gw':
      return new McliProvider(cfg.baseUrl!, cfg.apiKey!, cfg.models)
    default:
      throw new Error(`Unsupported provider type: ${cfg.type}`)
  }
}

export function buildProviderRegistry(config: Config): Map<string, Provider> {
  const registry = new Map<string, Provider>()
  for (const cfg of config.providers) {
    registry.set(cfg.name, buildProvider(cfg))
  }
  return registry
}

/**
 * Resolve a provider by routing string "providerName/modelName".
 * Returns [provider, modelName] or throws if not found.
 */
export function resolveRoute(
  registry: Map<string, Provider>,
  route: string
): [Provider, string] {
  const slash = route.indexOf('/')
  if (slash === -1) throw new Error(`Invalid route format: "${route}" (expected "provider/model")`)
  const providerName = route.slice(0, slash)
  const model = route.slice(slash + 1)
  const provider = registry.get(providerName)
  if (!provider) throw new Error(`Unknown provider: "${providerName}"`)
  return [provider, model]
}
```

- [ ] **Step 2: Build to verify types**

```bash
pnpm build
```

Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add src/providers/registry.ts
git commit -m "feat: provider registry and route resolver"
```

---

## Task 7: Memory Store

**Files:**
- Create: `src/memory/types.ts`
- Create: `src/memory/store.ts`
- Create: `tests/memory/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/memory/store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { InMemorySessionStore } from '../../src/memory/store.js'

describe('InMemorySessionStore', () => {
  let store: InMemorySessionStore

  beforeEach(() => {
    store = new InMemorySessionStore()
  })

  it('creates a new session and retrieves it', () => {
    const id = store.create()
    const session = store.get(id)
    expect(session).toBeDefined()
    expect(session!.id).toBe(id)
    expect(session!.messages).toEqual([])
  })

  it('returns undefined for unknown session', () => {
    expect(store.get('unknown-id')).toBeUndefined()
  })

  it('appends messages to a session', () => {
    const id = store.create()
    store.appendMessage(id, { role: 'user', content: 'Hello' })
    store.appendMessage(id, { role: 'assistant', content: 'Hi!' })
    const session = store.get(id)!
    expect(session.messages).toHaveLength(2)
    expect(session.messages[0].role).toBe('user')
    expect(session.messages[1].content).toBe('Hi!')
  })

  it('throws when appending to unknown session', () => {
    expect(() =>
      store.appendMessage('ghost', { role: 'user', content: 'x' })
    ).toThrow('Session not found')
  })

  it('deletes a session', () => {
    const id = store.create()
    store.delete(id)
    expect(store.get(id)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test tests/memory/store.test.ts
```

Expected: FAIL with "Cannot find module '../../src/memory/store.js'"

- [ ] **Step 3: Write types**

Create `src/memory/types.ts`:

```typescript
import type { Message } from '../providers/types.js'

export interface Session {
  id: string
  messages: Message[]
  createdAt: number
  updatedAt: number
}

export interface SessionStore {
  create(): string
  get(id: string): Session | undefined
  appendMessage(id: string, message: Message): void
  delete(id: string): void
}
```

- [ ] **Step 4: Write the in-memory store**

Create `src/memory/store.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import type { Session, SessionStore } from './types.js'
import type { Message } from '../providers/types.js'

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>()

  create(): string {
    const id = randomUUID()
    const now = Date.now()
    this.sessions.set(id, { id, messages: [], createdAt: now, updatedAt: now })
    return id
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  appendMessage(id: string, message: Message): void {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session not found: ${id}`)
    session.messages.push(message)
    session.updatedAt = Date.now()
  }

  delete(id: string): void {
    this.sessions.delete(id)
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm test tests/memory/store.test.ts
```

Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/memory/ tests/memory/
git commit -m "feat: in-memory session store"
```

---

## Task 8: Fastify Server — Health Route

**Files:**
- Create: `src/server/auth.ts`
- Create: `src/server/routes/health.ts`
- Create: `src/server/app.ts`
- Create: `tests/server/health.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/server/health.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../../src/server/app.js'
import { InMemorySessionStore } from '../../src/memory/store.js'

describe('GET /v1/health', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => {
    app = await buildApp({
      authToken: 'test-token',
      sessionStore: new InMemorySessionStore(),
      providerRegistry: new Map(),
      routing: { default: '', fallback: [] },
      agentConfig: { maxTurns: 10, timeoutSeconds: 30 },
    })
    await app.ready()
  })

  afterAll(() => app.close())

  it('returns 200 with status ok (no auth required)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('ok')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test tests/server/health.test.ts
```

Expected: FAIL with "Cannot find module '../../src/server/app.js'"

- [ ] **Step 3: Write auth hook**

Create `src/server/auth.ts`:

```typescript
import type { FastifyRequest, FastifyReply } from 'fastify'

export function createAuthHook(authToken: string) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply) {
    const auth = request.headers.authorization
    if (!auth || auth !== `Bearer ${authToken}`) {
      reply.code(401).send({ error: 'Unauthorized' })
    }
  }
}
```

- [ ] **Step 4: Write health route**

Create `src/server/routes/health.ts`:

```typescript
import type { FastifyInstance } from 'fastify'

export async function healthRoutes(app: FastifyInstance) {
  app.get('/v1/health', async (_request, reply) => {
    reply.send({ status: 'ok', timestamp: new Date().toISOString() })
  })
}
```

- [ ] **Step 5: Write app builder**

Create `src/server/app.ts`:

```typescript
import Fastify from 'fastify'
import type { Provider } from '../providers/types.js'
import type { SessionStore } from '../memory/types.js'
import { createAuthHook } from './auth.js'
import { healthRoutes } from './routes/health.js'

export interface AppDeps {
  authToken: string
  sessionStore: SessionStore
  providerRegistry: Map<string, Provider>
  routing: { default: string; fallback: string[] }
  agentConfig: { maxTurns: number; timeoutSeconds: number }
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: false })

  // Health route — no auth
  await app.register(healthRoutes)

  return app
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
pnpm test tests/server/health.test.ts
```

Expected: PASS (1 test)

- [ ] **Step 7: Commit**

```bash
git add src/server/auth.ts src/server/routes/health.ts src/server/app.ts tests/server/health.test.ts
git commit -m "feat: Fastify app with /v1/health route"
```

---

## Task 9: Chat Route

**Files:**
- Create: `src/server/routes/chat.ts`
- Modify: `src/server/app.ts`
- Create: `tests/server/chat.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/server/chat.test.ts`:

```typescript
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../../src/server/app.js'
import { InMemorySessionStore } from '../../src/memory/store.js'
import type { Provider, Message, ChatOptions, ChatResponse } from '../../src/providers/types.js'

function makeProvider(content: string): Provider {
  return {
    name: 'mock',
    chat: vi.fn<[Message[], ChatOptions], Promise<ChatResponse>>().mockResolvedValue({
      content,
      model: 'test-model',
      usage: { inputTokens: 5, outputTokens: 3 },
    }),
    stream: vi.fn(),
  }
}

describe('POST /v1/agent/chat', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  const mockProvider = makeProvider('Hello from mock!')

  beforeAll(async () => {
    const registry = new Map([['mock', mockProvider]])
    app = await buildApp({
      authToken: 'test-token',
      sessionStore: new InMemorySessionStore(),
      providerRegistry: registry,
      routing: { default: 'mock/test-model', fallback: [] },
      agentConfig: { maxTurns: 10, timeoutSeconds: 30 },
    })
    await app.ready()
  })

  afterAll(() => app.close())

  it('returns 401 without auth header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/chat',
      payload: { message: 'hi' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 400 when message is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/chat',
      headers: { authorization: 'Bearer test-token' },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 200 with assistant reply for a new session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/chat',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      payload: { message: 'Hello' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.reply).toBe('Hello from mock!')
    expect(typeof body.sessionId).toBe('string')
    expect(body.usage).toBeDefined()
  })

  it('maintains conversation history within a session', async () => {
    // First turn
    const first = await app.inject({
      method: 'POST',
      url: '/v1/agent/chat',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      payload: { message: 'Turn 1' },
    })
    const { sessionId } = JSON.parse(first.body)

    // Second turn with same session
    const second = await app.inject({
      method: 'POST',
      url: '/v1/agent/chat',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      payload: { message: 'Turn 2', sessionId },
    })
    expect(second.statusCode).toBe(200)

    // Verify provider received 3 messages (user, assistant, user)
    const chatCalls = (mockProvider.chat as ReturnType<typeof vi.fn>).mock.calls
    const lastCall = chatCalls[chatCalls.length - 1]
    const messages: Message[] = lastCall[0]
    expect(messages.length).toBeGreaterThanOrEqual(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test tests/server/chat.test.ts
```

Expected: FAIL (routes not registered yet)

- [ ] **Step 3: Write chat route**

Create `src/server/routes/chat.ts`:

```typescript
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { resolveRoute } from '../../providers/registry.js'

const ChatRequestSchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional(),
})

export async function chatRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post(
    '/v1/agent/chat',
    {
      preHandler: [app.authenticate],
    },
    async (request, reply) => {
      const parseResult = ChatRequestSchema.safeParse(request.body)
      if (!parseResult.success) {
        return reply.code(400).send({ error: 'Invalid request', details: parseResult.error.issues })
      }

      const { message, sessionId: existingSessionId } = parseResult.data

      // Get or create session
      let sessionId = existingSessionId
      if (!sessionId || !deps.sessionStore.get(sessionId)) {
        sessionId = deps.sessionStore.create()
      }

      // Add user message to session history
      deps.sessionStore.appendMessage(sessionId, { role: 'user', content: message })
      const session = deps.sessionStore.get(sessionId)!

      // Resolve provider using routing config
      let provider, model
      try {
        ;[provider, model] = resolveRoute(deps.providerRegistry, deps.routing.default)
      } catch (err) {
        return reply.code(503).send({ error: 'No provider available', details: String(err) })
      }

      // Call provider
      let response
      try {
        response = await provider.chat(session.messages, { model })
      } catch (err) {
        // Try fallback providers
        let lastErr = err
        for (const fallbackRoute of deps.routing.fallback) {
          try {
            const [fb, fm] = resolveRoute(deps.providerRegistry, fallbackRoute)
            response = await fb.chat(session.messages, { model: fm })
            break
          } catch (e) {
            lastErr = e
          }
        }
        if (!response) {
          return reply.code(502).send({ error: 'All providers failed', details: String(lastErr) })
        }
      }

      // Store assistant reply
      deps.sessionStore.appendMessage(sessionId, { role: 'assistant', content: response.content })

      return reply.send({
        reply: response.content,
        sessionId,
        model: response.model,
        usage: response.usage,
      })
    }
  )
}
```

- [ ] **Step 4: Update app.ts to register auth decorator and chat route**

Edit `src/server/app.ts` — replace entire file content:

```typescript
import Fastify from 'fastify'
import type { Provider } from '../providers/types.js'
import type { SessionStore } from '../memory/types.js'
import { createAuthHook } from './auth.js'
import { healthRoutes } from './routes/health.js'
import { chatRoutes } from './routes/chat.js'

export interface AppDeps {
  authToken: string
  sessionStore: SessionStore
  providerRegistry: Map<string, Provider>
  routing: { default: string; fallback: string[] }
  agentConfig: { maxTurns: number; timeoutSeconds: number }
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: false })

  // Decorate with auth hook so routes can reference app.authenticate
  const authHook = createAuthHook(deps.authToken)
  app.decorate('authenticate', authHook)

  // Health route — no auth
  await app.register(healthRoutes)

  // Chat route — auth required (registered with preHandler)
  await app.register(chatRoutes, deps)

  return app
}

// Extend FastifyInstance type with authenticate decorator
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm test tests/server/chat.test.ts
```

Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/chat.ts src/server/app.ts tests/server/chat.test.ts
git commit -m "feat: POST /v1/agent/chat with session management and provider fallback"
```

---

## Task 10: Entry Point

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Write the entry point**

Create `src/index.ts`:

```typescript
import { resolve } from 'node:path'
import { loadConfig } from './config/loader.js'
import { buildProviderRegistry } from './providers/registry.js'
import { InMemorySessionStore } from './memory/store.js'
import { buildApp } from './server/app.js'

const configPath = process.env['CONFIG_PATH'] ?? resolve(process.cwd(), 'config.yaml')

async function main() {
  const config = await loadConfig(configPath)
  const providerRegistry = buildProviderRegistry(config)
  const sessionStore = new InMemorySessionStore()

  const app = await buildApp({
    authToken: config.server.authToken,
    sessionStore,
    providerRegistry,
    routing: config.routing,
    agentConfig: config.agent,
  })

  await app.listen({ port: config.server.port, host: config.server.host })
  console.log(`GeminiClaw listening on ${config.server.host}:${config.server.port}`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
```

- [ ] **Step 2: Build the full project**

```bash
pnpm build
```

Expected: exit 0, `dist/` populated with `.js` files

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire entry point — config + providers + server"
```

---

## Task 11: Run All Tests

- [ ] **Step 1: Run the full test suite**

```bash
pnpm test
```

Expected: all tests pass (green)

- [ ] **Step 2: Run build one final time to confirm dist is clean**

```bash
pnpm build
```

Expected: exit 0

- [ ] **Step 3: Final commit (if any fixups were needed)**

```bash
git add -A
git commit -m "chore: ensure all tests pass and build is clean"
```

---

## Self-Review

### Spec Coverage

| CLAUDE.md requirement | Covered by |
|---|---|
| `src/config/` — load and validate config.yaml | Task 2 |
| `src/providers/` — Anthropic + llm-gw adapters | Tasks 3-6 |
| `src/server/` — Fastify, `/v1/agent/chat`, `/v1/health` | Tasks 8-9 |
| `src/memory/` — in-memory session store | Task 7 |
| Wire in `src/index.ts` | Task 10 |
| `POST /v1/agent/chat` | Task 9 |
| `GET /v1/health` | Task 8 |
| Provider interface `chat()` and `stream()` | Tasks 3-5 |
| Config from config.yaml only, no hardcoded secrets | Task 2 |
| BSL 1.1 license (no GPL deps) | All deps already in package.json |
| `pnpm build` and `pnpm test` | Task 11 |

All requirements covered.

### Placeholder Scan

No TBD/TODO/placeholder steps found. All code blocks are complete.

### Type Consistency

- `Message` used in `providers/types.ts`, `memory/types.ts`, `memory/store.ts`, `server/routes/chat.ts` — all import from `providers/types.js` ✓
- `AppDeps` defined in `server/app.ts`, referenced in `server/routes/chat.ts` ✓
- `resolveRoute` defined in `providers/registry.ts`, imported in `server/routes/chat.ts` ✓
- `loadConfig` returns `Config`, used in `index.ts` ✓
