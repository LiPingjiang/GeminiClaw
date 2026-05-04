# GeminiClaw src/ Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete `src/` directory from scratch — config loader, provider adapters (Anthropic + mcli), session memory, Fastify HTTP server, and entry point — with passing tests and a clean `pnpm build`.

**Architecture:** Config is loaded first via Zod-validated YAML, then providers are constructed from config and wrapped in a router with fallback logic. A Fastify server exposes `/v1/health` and `POST /v1/agent/chat` (Bearer-token-gated), backed by session memory that accumulates per-`sessionId` message history. `src/index.ts` wires all modules together and starts the server.

**Tech Stack:** TypeScript (ESM, NodeNext), Fastify 5, `@anthropic-ai/sdk`, `js-yaml`, `zod`, Vitest

---

## File Map

| File | Responsibility |
|------|----------------|
| `tsconfig.json` | Compiler settings — NodeNext modules, ES2022 target, strict |
| `src/config/schema.ts` | Zod schema + exported `Config` / `ProviderConfig` types |
| `src/config/loader.ts` | `loadConfig(path?)` — reads YAML, validates against schema |
| `src/providers/types.ts` | `Message`, `ChatOptions`, `ChatResponse`, `StreamChunk`, `Provider` interfaces |
| `src/providers/anthropic.ts` | `AnthropicProvider` — wraps `@anthropic-ai/sdk` |
| `src/providers/mcli.ts` | `McliProvider` — same SDK, custom `baseURL` |
| `src/providers/router.ts` | `ProviderRouter` — primary + ordered fallback |
| `src/memory/session.ts` | `SessionMemory` — `Map<sessionId, Message[]>` |
| `src/server/routes/health.ts` | `GET /v1/health` route plugin |
| `src/server/routes/chat.ts` | `POST /v1/agent/chat` route plugin |
| `src/server/index.ts` | `buildServer(config, router, memory)` — registers plugins + routes |
| `src/index.ts` | Entry point — load config, build providers, start server |
| `src/config/loader.test.ts` | Tests for `loadConfig` |
| `src/providers/anthropic.test.ts` | Tests for `AnthropicProvider` (mocked SDK) |
| `src/providers/mcli.test.ts` | Tests for `McliProvider` (mocked SDK) |
| `src/providers/router.test.ts` | Tests for `ProviderRouter` fallback logic |
| `src/memory/session.test.ts` | Tests for `SessionMemory` |
| `src/server/routes/health.test.ts` | Tests for health route |
| `src/server/routes/chat.test.ts` | Tests for chat route (mocked router + memory) |

---

## Task 1: tsconfig.json

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
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 2: Verify TypeScript can see the config**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && npx tsc --showConfig | head -20
```

Expected: JSON output showing `module: "nodenext"` and `strict: true`.

- [ ] **Step 3: Commit**

```bash
git add tsconfig.json
git commit -m "build: add tsconfig.json (NodeNext, ES2022, strict)"
```

---

## Task 2: Config schema

**Files:**
- Create: `src/config/schema.ts`
- Create: `src/config/loader.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/config/loader.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ConfigSchema } from './schema.js'

describe('ConfigSchema', () => {
  it('accepts a valid minimal config', () => {
    const raw = {
      server: { port: 18888, host: '127.0.0.1', authToken: 'tok' },
      providers: [
        { name: 'anthropic', type: 'anthropic', apiKey: 'sk-ant', models: ['claude-opus-4'] }
      ],
      routing: { default: 'anthropic/claude-opus-4', fallback: [] },
      memory: { enabled: false, dataDir: './data', maxSessionAge: 86400 },
      agent: { maxTurns: 50, timeoutSeconds: 300 }
    }
    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(true)
  })

  it('rejects missing authToken', () => {
    const raw = {
      server: { port: 18888, host: '127.0.0.1' },
      providers: [],
      routing: { default: '', fallback: [] },
      memory: { enabled: false, dataDir: './data', maxSessionAge: 86400 },
      agent: { maxTurns: 50, timeoutSeconds: 300 }
    }
    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && npx vitest run src/config/loader.test.ts 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './schema.js'`

- [ ] **Step 3: Write ConfigSchema**

Create `src/config/schema.ts`:

```typescript
import { z } from 'zod'

export const ProviderConfigSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['anthropic', 'mcli', 'openai', 'friday']),
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  models: z.array(z.string()).min(1)
})

export const ConfigSchema = z.object({
  server: z.object({
    port: z.number().int().min(1).max(65535).default(18888),
    host: z.string().default('127.0.0.1'),
    authToken: z.string().min(1)
  }),
  providers: z.array(ProviderConfigSchema),
  routing: z.object({
    default: z.string(),
    fallback: z.array(z.string()).default([])
  }),
  memory: z.object({
    enabled: z.boolean().default(true),
    dataDir: z.string().default('./data/memory'),
    maxSessionAge: z.number().int().positive().default(86400)
  }),
  agent: z.object({
    maxTurns: z.number().int().positive().default(50),
    timeoutSeconds: z.number().int().positive().default(300)
  })
})

export type Config = z.infer<typeof ConfigSchema>
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && npx vitest run src/config/loader.test.ts 2>&1 | tail -20
```

Expected: PASS — 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts src/config/loader.test.ts
git commit -m "feat: add config schema (Zod) with tests"
```

---

## Task 3: Config loader

**Files:**
- Create: `src/config/loader.ts`
- Modify: `src/config/loader.test.ts` (add loadConfig tests)

- [ ] **Step 1: Add loadConfig tests to loader.test.ts**

Append to `src/config/loader.test.ts`:

```typescript
import { loadConfig } from './loader.js'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

describe('loadConfig', () => {
  const tmpPath = join(process.cwd(), 'test-config-tmp.yaml')

  it('loads and validates a YAML config file', () => {
    writeFileSync(tmpPath, `
server:
  port: 3000
  host: "0.0.0.0"
  authToken: "test-token"
providers:
  - name: anthropic
    type: anthropic
    apiKey: "sk-ant-test"
    models:
      - claude-opus-4
routing:
  default: anthropic/claude-opus-4
  fallback: []
memory:
  enabled: false
  dataDir: "./data"
  maxSessionAge: 3600
agent:
  maxTurns: 10
  timeoutSeconds: 60
`)
    const config = loadConfig(tmpPath)
    expect(config.server.port).toBe(3000)
    expect(config.server.authToken).toBe('test-token')
    expect(config.providers).toHaveLength(1)
    expect(config.providers[0].name).toBe('anthropic')
    unlinkSync(tmpPath)
  })

  it('throws if file does not exist', () => {
    expect(() => loadConfig('/nonexistent/path.yaml')).toThrow()
  })

  it('throws if config is invalid', () => {
    writeFileSync(tmpPath, `
server:
  port: 3000
  host: "0.0.0.0"
providers: []
routing:
  default: ""
  fallback: []
memory:
  enabled: false
  dataDir: "./data"
  maxSessionAge: 3600
agent:
  maxTurns: 10
  timeoutSeconds: 60
`)
    expect(() => loadConfig(tmpPath)).toThrow()
    unlinkSync(tmpPath)
  })
})
```

- [ ] **Step 2: Run to verify new tests fail**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && npx vitest run src/config/loader.test.ts 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './loader.js'`

- [ ] **Step 3: Write loadConfig**

Create `src/config/loader.ts`:

```typescript
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { ConfigSchema, type Config } from './schema.js'

export function loadConfig(configPath?: string): Config {
  const path = configPath ?? `${process.cwd()}/config.yaml`
  const raw = readFileSync(path, 'utf-8')
  const parsed = load(raw)
  const result = ConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`Invalid config at ${path}:\n${result.error.message}`)
  }
  return result.data
}
```

- [ ] **Step 4: Run all config tests**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && npx vitest run src/config/loader.test.ts 2>&1 | tail -20
```

Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/config/loader.ts src/config/loader.test.ts
git commit -m "feat: add config loader with YAML + Zod validation"
```

---

## Task 4: Provider types

**Files:**
- Create: `src/providers/types.ts`

- [ ] **Step 1: Write types.ts — no test needed, pure types**

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
  usage?: {
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

- [ ] **Step 2: Commit**

```bash
git add src/providers/types.ts
git commit -m "feat: add provider types (Message, ChatOptions, ChatResponse, Provider)"
```

---

## Task 5: AnthropicProvider

**Files:**
- Create: `src/providers/anthropic.ts`
- Create: `src/providers/anthropic.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/providers/anthropic.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message, ChatOptions } from './types.js'

// Mock the Anthropic SDK before importing the provider
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn()
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: mockCreate }
    })),
    __mockCreate: mockCreate
  }
})

describe('AnthropicProvider', () => {
  let mockCreate: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    const mod = await import('@anthropic-ai/sdk')
    // @ts-ignore
    mockCreate = mod.__mockCreate
    mockCreate.mockReset()
  })

  it('sends messages and returns response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Hello from Claude' }],
      model: 'claude-opus-4',
      usage: { input_tokens: 10, output_tokens: 5 }
    })

    const { AnthropicProvider } = await import('./anthropic.js')
    const provider = new AnthropicProvider({ apiKey: 'sk-test', models: ['claude-opus-4'] })

    const messages: Message[] = [{ role: 'user', content: 'hi' }]
    const options: ChatOptions = { model: 'claude-opus-4', maxTokens: 100 }
    const response = await provider.chat(messages, options)

    expect(response.content).toBe('Hello from Claude')
    expect(response.model).toBe('claude-opus-4')
    expect(response.usage?.inputTokens).toBe(10)
    expect(response.usage?.outputTokens).toBe(5)
  })

  it('has name "anthropic"', async () => {
    const { AnthropicProvider } = await import('./anthropic.js')
    const provider = new AnthropicProvider({ apiKey: 'sk-test', models: ['claude-opus-4'] })
    expect(provider.name).toBe('anthropic')
  })

  it('throws if SDK returns no text content', async () => {
    mockCreate.mockResolvedValue({
      content: [],
      model: 'claude-opus-4',
      usage: { input_tokens: 5, output_tokens: 0 }
    })

    const { AnthropicProvider } = await import('./anthropic.js')
    const provider = new AnthropicProvider({ apiKey: 'sk-test', models: ['claude-opus-4'] })
    const messages: Message[] = [{ role: 'user', content: 'hi' }]
    const options: ChatOptions = { model: 'claude-opus-4' }

    await expect(provider.chat(messages, options)).rejects.toThrow('No text content')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && npx vitest run src/providers/anthropic.test.ts 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './anthropic.js'`

- [ ] **Step 3: Write AnthropicProvider**

Create `src/providers/anthropic.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk'
import type { Message, ChatOptions, ChatResponse, StreamChunk, Provider } from './types.js'

interface AnthropicProviderConfig {
  apiKey: string
  models: string[]
  baseURL?: string
}

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic'
  private client: Anthropic

  constructor(config: AnthropicProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {})
    })
  }

  async chat(messages: Message[], options: ChatOptions): Promise<ChatResponse> {
    const anthropicMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const systemMessage = messages.find(m => m.role === 'system')?.content
      ?? options.systemPrompt

    const response = await this.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      ...(systemMessage ? { system: systemMessage } : {}),
      messages: anthropicMessages
    })

    const textBlock = response.content.find(b => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text content in Anthropic response')
    }

    return {
      content: textBlock.text,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens
      }
    }
  }

  async *stream(messages: Message[], options: ChatOptions): AsyncIterable<StreamChunk> {
    const anthropicMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const systemMessage = messages.find(m => m.role === 'system')?.content
      ?? options.systemPrompt

    const stream = this.client.messages.stream({
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      ...(systemMessage ? { system: systemMessage } : {}),
      messages: anthropicMessages
    })

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { delta: event.delta.text, done: false }
      }
    }
    yield { delta: '', done: true }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && npx vitest run src/providers/anthropic.test.ts 2>&1 | tail -20
```

Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/providers/anthropic.ts src/providers/anthropic.test.ts
git commit -m "feat: add AnthropicProvider with chat + stream"
```

---

## Task 6: McliProvider

**Files:**
- Create: `src/providers/mcli.ts`
- Create: `src/providers/mcli.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/providers/mcli.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message, ChatOptions } from './types.js'

vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn()
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate }
  }))
  return { default: MockAnthropic, __mockCreate: mockCreate, __MockAnthropic: MockAnthropic }
})

describe('McliProvider', () => {
  let mockCreate: ReturnType<typeof vi.fn>
  let MockAnthropic: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    const mod = await import('@anthropic-ai/sdk')
    // @ts-ignore
    mockCreate = mod.__mockCreate
    // @ts-ignore
    MockAnthropic = mod.__MockAnthropic
    mockCreate.mockReset()
    MockAnthropic.mockClear()
  })

  it('has name "mcli"', async () => {
    const { McliProvider } = await import('./mcli.js')
    const p = new McliProvider({
      apiKey: 'tok',
      baseUrl: 'https://mcli.example.com',
      models: ['claude-opus-4-6']
    })
    expect(p.name).toBe('mcli')
  })

  it('initialises Anthropic SDK with custom baseURL', async () => {
    const { McliProvider } = await import('./mcli.js')
    new McliProvider({
      apiKey: 'tok',
      baseUrl: 'https://mcli.example.com',
      models: ['claude-opus-4-6']
    })
    expect(MockAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://mcli.example.com' })
    )
  })

  it('delegates chat to underlying AnthropicProvider', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'mcli reply' }],
      model: 'claude-opus-4-6',
      usage: { input_tokens: 5, output_tokens: 3 }
    })

    const { McliProvider } = await import('./mcli.js')
    const p = new McliProvider({
      apiKey: 'tok',
      baseUrl: 'https://mcli.example.com',
      models: ['claude-opus-4-6']
    })

    const messages: Message[] = [{ role: 'user', content: 'hello' }]
    const options: ChatOptions = { model: 'claude-opus-4-6' }
    const resp = await p.chat(messages, options)
    expect(resp.content).toBe('mcli reply')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && npx vitest run src/providers/mcli.test.ts 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './mcli.js'`

- [ ] **Step 3: Write McliProvider**

Create `src/providers/mcli.ts`:

```typescript
import { AnthropicProvider } from './anthropic.js'
import type { Message, ChatOptions, ChatResponse, StreamChunk, Provider } from './types.js'

interface McliProviderConfig {
  apiKey: string
  baseUrl: string
  models: string[]
}

export class McliProvider implements Provider {
  readonly name = 'mcli'
  private inner: AnthropicProvider

  constructor(config: McliProviderConfig) {
    this.inner = new AnthropicProvider({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      models: config.models
    })
  }

  chat(messages: Message[], options: ChatOptions): Promise<ChatResponse> {
    return this.inner.chat(messages, options)
  }

  stream(messages: Message[], options: ChatOptions): AsyncIterable<StreamChunk> {
    return this.inner.stream(messages, options)
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && npx vitest run src/providers/mcli.test.ts 2>&1 | tail -20
```

Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/providers/mcli.ts src/providers/mcli.test.ts
git commit -m "feat: add McliProvider (Anthropic SDK + custom baseURL)"
```

---

## Task 7: ProviderRouter

**Files:**
- Create: `src/providers/router.ts`
- Create: `src/providers/router.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/providers/router.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import type { Provider, Message, ChatOptions, ChatResponse } from './types.js'

function makeProvider(name: string, impl: Partial<Provider> = {}): Provider {
  return {
    name,
    chat: vi.fn().mockResolvedValue({ content: `response from ${name}`, model: 'x', usage: undefined }),
    stream: vi.fn(),
    ...impl
  }
}

describe('ProviderRouter', () => {
  it('uses primary provider when it succeeds', async () => {
    const { ProviderRouter } = await import('./router.js')
    const primary = makeProvider('primary')
    const fallback = makeProvider('fallback')
    const router = new ProviderRouter([primary, fallback])

    const messages: Message[] = [{ role: 'user', content: 'hello' }]
    const options: ChatOptions = { model: 'test-model' }
    const result = await router.chat(messages, options)

    expect(result.content).toBe('response from primary')
    expect(primary.chat).toHaveBeenCalledOnce()
    expect(fallback.chat).not.toHaveBeenCalled()
  })

  it('falls back to next provider on error', async () => {
    const { ProviderRouter } = await import('./router.js')
    const primary = makeProvider('primary', {
      chat: vi.fn().mockRejectedValue(new Error('primary failed'))
    })
    const fallback = makeProvider('fallback')
    const router = new ProviderRouter([primary, fallback])

    const messages: Message[] = [{ role: 'user', content: 'hello' }]
    const options: ChatOptions = { model: 'test-model' }
    const result = await router.chat(messages, options)

    expect(result.content).toBe('response from fallback')
  })

  it('throws if all providers fail', async () => {
    const { ProviderRouter } = await import('./router.js')
    const p1 = makeProvider('p1', { chat: vi.fn().mockRejectedValue(new Error('fail1')) })
    const p2 = makeProvider('p2', { chat: vi.fn().mockRejectedValue(new Error('fail2')) })
    const router = new ProviderRouter([p1, p2])

    const messages: Message[] = [{ role: 'user', content: 'hello' }]
    const options: ChatOptions = { model: 'test-model' }
    await expect(router.chat(messages, options)).rejects.toThrow('All providers failed')
  })

  it('throws if no providers configured', async () => {
    const { ProviderRouter } = await import('./router.js')
    expect(() => new ProviderRouter([])).toThrow('At least one provider required')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && npx vitest run src/providers/router.test.ts 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './router.js'`

- [ ] **Step 3: Write ProviderRouter**

Create `src/providers/router.ts`:

```typescript
import type { Provider, Message, ChatOptions, ChatResponse, StreamChunk } from './types.js'

export class ProviderRouter implements Provider {
  readonly name = 'router'
  private providers: Provider[]

  constructor(providers: Provider[]) {
    if (providers.length === 0) {
      throw new Error('At least one provider required')
    }
    this.providers = providers
  }

  async chat(messages: Message[], options: ChatOptions): Promise<ChatResponse> {
    const errors: Error[] = []
    for (const provider of this.providers) {
      try {
        return await provider.chat(messages, options)
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)))
      }
    }
    throw new Error(`All providers failed: ${errors.map(e => e.message).join('; ')}`)
  }

  async *stream(messages: Message[], options: ChatOptions): AsyncIterable<StreamChunk> {
    const errors: Error[] = []
    for (const provider of this.providers) {
      try {
        yield* provider.stream(messages, options)
        return
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)))
      }
    }
    throw new Error(`All providers failed: ${errors.map(e => e.message).join('; ')}`)
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && npx vitest run src/providers/router.test.ts 2>&1 | tail -20
```

Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/providers/router.ts src/providers/router.test.ts
git commit -m "feat: add ProviderRouter with ordered fallback"
```

---

## Task 8: SessionMemory

**Files:**
- Create: `src/memory/session.ts`
- Create: `src/memory/session.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/memory/session.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'

describe('SessionMemory', () => {
  it('stores and retrieves messages by sessionId', async () => {
    const { SessionMemory } = await import('./session.js')
    const mem = new SessionMemory()
    mem.append('sess-1', { role: 'user', content: 'hello' })
    mem.append('sess-1', { role: 'assistant', content: 'hi' })

    const msgs = mem.get('sess-1')
    expect(msgs).toHaveLength(2)
    expect(msgs[0].content).toBe('hello')
    expect(msgs[1].role).toBe('assistant')
  })

  it('returns empty array for unknown sessionId', async () => {
    const { SessionMemory } = await import('./session.js')
    const mem = new SessionMemory()
    expect(mem.get('unknown')).toEqual([])
  })

  it('keeps sessions isolated', async () => {
    const { SessionMemory } = await import('./session.js')
    const mem = new SessionMemory()
    mem.append('a', { role: 'user', content: 'msg-a' })
    mem.append('b', { role: 'user', content: 'msg-b' })

    expect(mem.get('a')).toHaveLength(1)
    expect(mem.get('b')).toHaveLength(1)
    expect(mem.get('a')[0].content).toBe('msg-a')
  })

  it('clears a session', async () => {
    const { SessionMemory } = await import('./session.js')
    const mem = new SessionMemory()
    mem.append('s', { role: 'user', content: 'msg' })
    mem.clear('s')
    expect(mem.get('s')).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && npx vitest run src/memory/session.test.ts 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './session.js'`

- [ ] **Step 3: Write SessionMemory**

Create `src/memory/session.ts`:

```typescript
import type { Message } from '../providers/types.js'

export class SessionMemory {
  private store = new Map<string, Message[]>()

  get(sessionId: string): Message[] {
    return this.store.get(sessionId) ?? []
  }

  append(sessionId: string, message: Message): void {
    const existing = this.store.get(sessionId) ?? []
    this.store.set(sessionId, [...existing, message])
  }

  clear(sessionId: string): void {
    this.store.delete(sessionId)
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && npx vitest run src/memory/session.test.ts 2>&1 | tail -20
```

Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/memory/session.ts src/memory/session.test.ts
git commit -m "feat: add SessionMemory (in-memory per-session message store)"
```

---

## Task 9: Health route

**Files:**
- Create: `src/server/routes/health.ts`
- Create: `src/server/routes/health.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/routes/health.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'

describe('GET /v1/health', () => {
  it('returns 200 with status ok', async () => {
    const { healthRoute } = await import('./health.js')
    const app = Fastify()
    await app.register(healthRoute)

    const resp = await app.inject({ method: 'GET', url: '/v1/health' })
    expect(resp.statusCode).toBe(200)
    const body = JSON.parse(resp.body)
    expect(body.status).toBe('ok')
    expect(typeof body.uptime).toBe('number')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && npx vitest run src/server/routes/health.test.ts 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './health.js'`

- [ ] **Step 3: Write healthRoute**

Create `src/server/routes/health.ts`:

```typescript
import type { FastifyInstance } from 'fastify'

export async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get('/v1/health', async (_request, reply) => {
    return reply.send({ status: 'ok', uptime: process.uptime() })
  })
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && npx vitest run src/server/routes/health.test.ts 2>&1 | tail -20
```

Expected: PASS — 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/health.ts src/server/routes/health.test.ts
git commit -m "feat: add GET /v1/health route"
```

---

## Task 10: Chat route

**Files:**
- Create: `src/server/routes/chat.ts`
- Create: `src/server/routes/chat.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/routes/chat.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import type { Provider, Message, ChatOptions, ChatResponse } from '../../providers/types.js'
import type { SessionMemory } from '../../memory/session.js'

function makeMockRouter(): Provider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({
      content: 'mocked response',
      model: 'test-model',
      usage: { inputTokens: 5, outputTokens: 3 }
    } satisfies ChatResponse),
    stream: vi.fn()
  }
}

function makeMockMemory(): SessionMemory {
  const store = new Map<string, Message[]>()
  return {
    get: (id: string) => store.get(id) ?? [],
    append: (id: string, msg: Message) => {
      store.set(id, [...(store.get(id) ?? []), msg])
    },
    clear: (id: string) => { store.delete(id) }
  } as unknown as SessionMemory
}

describe('POST /v1/agent/chat', () => {
  const authToken = 'test-bearer-token'

  async function buildApp() {
    const { chatRoute } = await import('./chat.js')
    const app = Fastify()
    await app.register(chatRoute, {
      router: makeMockRouter(),
      memory: makeMockMemory(),
      authToken,
      defaultModel: 'test-model'
    })
    return app
  }

  it('returns 401 without Bearer token', async () => {
    const app = await buildApp()
    const resp = await app.inject({
      method: 'POST',
      url: '/v1/agent/chat',
      payload: { message: 'hi' }
    })
    expect(resp.statusCode).toBe(401)
  })

  it('returns 401 with wrong token', async () => {
    const app = await buildApp()
    const resp = await app.inject({
      method: 'POST',
      url: '/v1/agent/chat',
      headers: { authorization: 'Bearer wrong-token' },
      payload: { message: 'hi' }
    })
    expect(resp.statusCode).toBe(401)
  })

  it('returns 200 with valid token and message', async () => {
    const app = await buildApp()
    const resp = await app.inject({
      method: 'POST',
      url: '/v1/agent/chat',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { message: 'hello world' }
    })
    expect(resp.statusCode).toBe(200)
    const body = JSON.parse(resp.body)
    expect(body.response).toBe('mocked response')
    expect(typeof body.sessionId).toBe('string')
    expect(body.model).toBe('test-model')
  })

  it('preserves sessionId across calls', async () => {
    const app = await buildApp()
    const first = await app.inject({
      method: 'POST',
      url: '/v1/agent/chat',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { message: 'first' }
    })
    const { sessionId } = JSON.parse(first.body)

    const second = await app.inject({
      method: 'POST',
      url: '/v1/agent/chat',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { message: 'second', sessionId }
    })
    expect(JSON.parse(second.body).sessionId).toBe(sessionId)
  })

  it('returns 400 if message is missing', async () => {
    const app = await buildApp()
    const resp = await app.inject({
      method: 'POST',
      url: '/v1/agent/chat',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {}
    })
    expect(resp.statusCode).toBe(400)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && npx vitest run src/server/routes/chat.test.ts 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './chat.js'`

- [ ] **Step 3: Write chatRoute**

Create `src/server/routes/chat.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Provider } from '../../providers/types.js'
import type { SessionMemory } from '../../memory/session.js'

interface ChatRouteOptions {
  router: Provider
  memory: SessionMemory
  authToken: string
  defaultModel: string
}

interface ChatBody {
  message: string
  sessionId?: string
  model?: string
}

export async function chatRoute(
  app: FastifyInstance,
  options: ChatRouteOptions
): Promise<void> {
  app.post<{ Body: ChatBody }>(
    '/v1/agent/chat',
    {
      schema: {
        body: {
          type: 'object',
          required: ['message'],
          properties: {
            message: { type: 'string', minLength: 1 },
            sessionId: { type: 'string' },
            model: { type: 'string' }
          }
        }
      }
    },
    async (request, reply) => {
      // Auth check
      const authHeader = request.headers.authorization ?? ''
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
      if (token !== options.authToken) {
        return reply.status(401).send({ error: 'Unauthorized' })
      }

      const { message, sessionId: incomingId, model } = request.body
      const sessionId = incomingId ?? randomUUID()
      const resolvedModel = model ?? options.defaultModel

      // Build message history
      const history = options.memory.get(sessionId)
      options.memory.append(sessionId, { role: 'user', content: message })
      const messages = [...history, { role: 'user' as const, content: message }]

      // Call provider
      const response = await options.router.chat(messages, { model: resolvedModel })
      options.memory.append(sessionId, { role: 'assistant', content: response.content })

      return reply.send({
        response: response.content,
        sessionId,
        model: response.model
      })
    }
  )
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && npx vitest run src/server/routes/chat.test.ts 2>&1 | tail -20
```

Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/chat.ts src/server/routes/chat.test.ts
git commit -m "feat: add POST /v1/agent/chat with auth + session memory"
```

---

## Task 11: buildServer

**Files:**
- Create: `src/server/index.ts`

- [ ] **Step 1: Write buildServer (no separate test — tested implicitly by route tests + integration)**

Create `src/server/index.ts`:

```typescript
import Fastify, { type FastifyInstance } from 'fastify'
import type { Config } from '../config/schema.js'
import type { Provider } from '../providers/types.js'
import type { SessionMemory } from '../memory/session.js'
import { healthRoute } from './routes/health.js'
import { chatRoute } from './routes/chat.js'

export async function buildServer(
  config: Config,
  router: Provider,
  memory: SessionMemory
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true })

  await app.register(healthRoute)
  await app.register(chatRoute, {
    router,
    memory,
    authToken: config.server.authToken,
    defaultModel: config.routing.default
  })

  return app
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/index.ts
git commit -m "feat: add buildServer (Fastify factory)"
```

---

## Task 12: Provider factory helper

**Files:**
- Create: `src/providers/factory.ts`

- [ ] **Step 1: Write factory (no test — thin glue over tested constructors)**

Create `src/providers/factory.ts`:

```typescript
import type { Config } from '../config/schema.js'
import { AnthropicProvider } from './anthropic.js'
import { McliProvider } from './mcli.js'
import { ProviderRouter } from './router.js'
import type { Provider } from './types.js'

export function buildProviders(config: Config): ProviderRouter {
  const providers: Provider[] = config.providers.map(pc => {
    switch (pc.type) {
      case 'anthropic':
        return new AnthropicProvider({
          apiKey: pc.apiKey ?? '',
          models: pc.models
        })
      case 'mcli':
        return new McliProvider({
          apiKey: pc.apiKey ?? '',
          baseUrl: pc.baseUrl ?? '',
          models: pc.models
        })
      default:
        throw new Error(`Unsupported provider type: ${pc.type}`)
    }
  })
  return new ProviderRouter(providers)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/providers/factory.ts
git commit -m "feat: add provider factory (buildProviders)"
```

---

## Task 13: Entry point

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Write src/index.ts**

Create `src/index.ts`:

```typescript
import { loadConfig } from './config/loader.js'
import { buildProviders } from './providers/factory.js'
import { SessionMemory } from './memory/session.js'
import { buildServer } from './server/index.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const router = buildProviders(config)
  const memory = new SessionMemory()
  const app = await buildServer(config, router, memory)

  await app.listen({ port: config.server.port, host: config.server.host })
  console.log(`GeminiClaw listening on ${config.server.host}:${config.server.port}`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
```

- [ ] **Step 2: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire up entry point (loadConfig → buildProviders → buildServer)"
```

---

## Task 14: Full build + test run

**Files:** none new

- [ ] **Step 1: Run pnpm build**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && pnpm build 2>&1
```

Expected: exit 0, `dist/` populated.

- [ ] **Step 2: Fix any TypeScript errors**

If errors appear, fix them and re-run `pnpm build` until clean.

- [ ] **Step 3: Run pnpm test**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw && pnpm test 2>&1
```

Expected: all tests PASS, 0 failures.

- [ ] **Step 4: Fix any test failures**

If tests fail, diagnose and fix, then re-run until all pass.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "build: verify full build + test suite passes"
```
