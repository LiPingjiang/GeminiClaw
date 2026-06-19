// GeminiClaw adapter: bridges Claude Code's REPL.tsx query() contract to
// GeminiClaw's /v1/agent/stream SSE endpoint.
//
// REPL.tsx calls: `for await (const event of query({ messages, systemPrompt, ... }))`
// and passes each event to `onQueryEvent` → `handleMessageFromStream`.
//
// handleMessageFromStream understands these event shapes:
//   1. { type: 'stream_request_start' }                          → spinner 'requesting'
//   2. { type: 'stream_event', event: { type: 'message_start' } } → ttftMs metrics
//   3. { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } } → spinner 'responding'
//   4. { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } } → streaming text
//   5. { type: 'stream_event', event: { type: 'message_stop' } }  → spinner 'tool-use'
//   6. { type: 'assistant', message: { ... } }                   → final message saved to messages array

import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import os from 'os'
import http from 'http'
import https from 'https'
import yaml from 'js-yaml'

// ---------- server config (mirrors app.tsx loadServerConfig) -----------------

interface ServerConfig {
  baseUrl: string
  authToken?: string
}

function loadServerConfig(): ServerConfig {
  const userCfg = join(os.homedir(), '.gemeniclaw', 'config.yaml')
  const cwdCfg = join(process.cwd(), 'config.yaml')
  const cfgPath = existsSync(userCfg) ? userCfg : existsSync(cwdCfg) ? cwdCfg : null

  let port = 18888
  let host = '127.0.0.1'
  let authToken: string | undefined

  if (cfgPath) {
    try {
      const raw = yaml.load(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>
      const server = raw?.server as Record<string, unknown> | undefined
      port = (server?.port as number) ?? port
      host = (server?.host as string) ?? host
      authToken = server?.authToken as string | undefined
    } catch { /* ignore */ }
  }

  if (process.env.GC_SERVER_URL) {
    return { baseUrl: process.env.GC_SERVER_URL, authToken: process.env.GC_AUTH_TOKEN ?? authToken }
  }

  return { baseUrl: `http://${host}:${port}`, authToken }
}

// ---------- SSE streaming helper ---------------------------------------------

interface AgentEvent {
  type: string
  delta?: string
  error?: string
  sessionId?: string
}

function streamGeminiClaw(opts: {
  baseUrl: string
  authToken?: string
  message: string
  sessionId?: string
  model?: string
  onDelta: (text: string) => void
  onSessionId: (id: string) => void
  onDone: () => void
  onError: (err: Error) => void
}): () => void {
  const url = new URL('/v1/agent/stream', opts.baseUrl)
  const transport = url.protocol === 'https:' ? https : http

  const body = JSON.stringify({
    message: opts.message,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  })

  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body).toString(),
    Accept: 'text/event-stream',
    'Cache-Control': 'no-cache',
  }
  if (opts.authToken) reqHeaders['Authorization'] = `Bearer ${opts.authToken}`

  let done = false
  const finish = (cb: () => void): void => {
    if (!done) { done = true; cb() }
  }

  const req = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: reqHeaders,
    },
    (res) => {
      if (res.statusCode !== 200) {
        let errBody = ''
        res.setEncoding('utf-8')
        res.on('data', (c: string) => { errBody += c })
        res.on('end', () => finish(() => opts.onError(new Error(`HTTP ${res.statusCode}: ${errBody}`))))
        return
      }

      let buffer = ''
      let currentEvent = 'message'
      res.setEncoding('utf-8')

      res.on('data', (chunk: string) => {
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            const data = line.slice(5).trim()

            if (data === '[DONE]') {
              finish(opts.onDone)
              return
            }

            if (currentEvent === 'done') {
              try {
                const parsed = JSON.parse(data) as { sessionId?: string }
                if (parsed.sessionId) opts.onSessionId(parsed.sessionId)
              } catch { /* ignore */ }
              currentEvent = 'message'
              continue
            }

            if (currentEvent === 'error') {
              try {
                const parsed = JSON.parse(data) as { error?: string }
                finish(() => opts.onError(new Error(parsed.error ?? 'stream error')))
              } catch {
                finish(() => opts.onError(new Error(data)))
              }
              return
            }

            if (currentEvent === 'agent_event') {
              try {
                const raw = JSON.parse(data) as AgentEvent
                if (raw.type === 'message_delta' && raw.delta) {
                  opts.onDelta(raw.delta)
                }
              } catch { /* ignore */ }
            }

            currentEvent = 'message'
          } else if (line === '') {
            currentEvent = 'message'
          }
        }
      })

      res.on('end', () => finish(opts.onDone))
      res.on('error', (err: Error) => finish(() => opts.onError(err)))
    },
  )

  req.on('error', (err: Error) => finish(() => opts.onError(err)))
  req.write(body)
  req.end()

  return () => req.destroy()
}

// ---------- Minimal event shapes REPL.tsx / handleMessageFromStream expects --

interface StreamRequestStartEvent {
  type: 'stream_request_start'
}

interface StreamEvent {
  type: 'stream_event'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any
  ttftMs?: number
}

interface AssistantMessage {
  type: 'assistant'
  uuid: string
  timestamp: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any
  requestId: undefined
  apiError: undefined
  error: undefined
  errorDetails: undefined
  isApiErrorMessage: false
  isVirtual: undefined
}

function makeStreamEvent(event: Record<string, unknown>, ttftMs?: number): StreamEvent {
  return { type: 'stream_event', event, ...(ttftMs !== undefined ? { ttftMs } : {}) }
}

function makeAssistantMessage(text: string, model: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: randomUUID(),
      model,
      role: 'assistant',
      content: [{ type: 'text', text: text || '(no response)' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 0, output_tokens: 0 },
      container: null,
      context_management: null,
    },
    requestId: undefined,
    apiError: undefined,
    error: undefined,
    errorDetails: undefined,
    isApiErrorMessage: false,
    isVirtual: undefined,
  }
}

// ---------- Public types (compatible with CC's QueryParams) ------------------

export type QueryParams = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[]
  systemPrompt?: unknown
  userContext?: Record<string, string>
  systemContext?: Record<string, string>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  canUseTool?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolUseContext?: any
  fallbackModel?: string
  querySource?: unknown
  maxOutputTokensOverride?: number
  maxTurns?: number
  skipCacheWrite?: boolean
  taskBudget?: { total: number }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps?: any
}

// ---------- query() — the adapter REPL.tsx calls ----------------------------

export async function* query(
  params: QueryParams,
): AsyncGenerator<StreamRequestStartEvent | StreamEvent | AssistantMessage> {
  const srv = loadServerConfig()

  // Extract the latest user text from the messages array.
  // CC stores messages as { type: 'user', message: { content: string | ContentBlock[] } }
  const userMessage = params.messages
    .slice()
    .reverse()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .find((m: any) => m?.type === 'user' && !m?.isMeta)

  let userText = ''
  if (userMessage) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = (userMessage as any)?.message?.content
    if (typeof content === 'string') {
      userText = content
    } else if (Array.isArray(content)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userText = content
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => (b.text as string) ?? '')
        .join('')
    }
  }

  if (!userText.trim()) {
    yield makeAssistantMessage('', 'geminiclaw')
    return
  }

  // Signal that we're initiating an API request (sets spinner to 'requesting')
  const startEvent: StreamRequestStartEvent = { type: 'stream_request_start' }
  yield startEvent

  // Emit message_start — handleMessageFromStream reads ttftMs from this event
  const requestStartMs = Date.now()
  yield makeStreamEvent({
    type: 'message_start',
    message: {
      id: randomUUID(),
      model: 'geminiclaw',
      role: 'assistant',
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })

  // Emit content_block_start for the text block (sets spinner to 'responding')
  yield makeStreamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })

  // Bridge the callback-based SSE stream into async iteration via a shared queue
  const deltas: string[] = []
  let streamDone = false
  let streamError: Error | null = null
  let resolveNext: (() => void) | null = null
  let firstDeltaMs = 0

  const notify = (): void => {
    if (resolveNext) { const r = resolveNext; resolveNext = null; r() }
  }

  const cancelStream = streamGeminiClaw({
    baseUrl: srv.baseUrl,
    authToken: srv.authToken,
    message: userText,
    onDelta: (text) => {
      if (!firstDeltaMs) firstDeltaMs = Date.now()
      deltas.push(text)
      notify()
    },
    onSessionId: (_id) => { /* session ID tracking handled by app-level code if needed */ },
    onDone: () => { streamDone = true; notify() },
    onError: (err) => { streamError = err; streamDone = true; notify() },
  })

  let fullText = ''
  let emittedFirstDelta = false

  // Drain the queue, yielding content_block_delta events as they arrive
  while (!streamDone || deltas.length > 0) {
    if (deltas.length === 0 && !streamDone) {
      await new Promise<void>(resolve => { resolveNext = resolve })
    }
    while (deltas.length > 0) {
      const text = deltas.shift()!
      fullText += text

      const ttftMs = !emittedFirstDelta ? (firstDeltaMs - requestStartMs) : undefined
      emittedFirstDelta = true

      yield makeStreamEvent(
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        ttftMs,
      )
    }
  }

  // cancelStream() is a no-op after the stream has ended
  void cancelStream

  if (streamError !== null) {
    // Yield an assistant error message so the REPL shows something
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errMsg = (streamError as any)?.message ?? String(streamError)
    yield makeAssistantMessage(`Error connecting to GeminiClaw: ${errMsg}`, 'geminiclaw')
    return
  }

  // Close the content block and message (sets spinner to 'tool-use' then clears)
  yield makeStreamEvent({ type: 'content_block_stop', index: 0 })
  yield makeStreamEvent({ type: 'message_stop' })

  // Yield the final complete assistant message — REPL appends this to messages[]
  yield makeAssistantMessage(fullText, 'geminiclaw')
}
