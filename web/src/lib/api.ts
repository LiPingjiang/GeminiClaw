// ── Config (stored in localStorage) ────────────────────────────────────────

export interface GcConfig {
  authToken: string
}

export function getConfig(): GcConfig {
  return {
    authToken: localStorage.getItem('gc_auth_token') ?? '',
  }
}

export function saveConfig(config: GcConfig): void {
  localStorage.setItem('gc_auth_token', config.authToken)
}

function authHeaders(): Record<string, string> {
  const { authToken } = getConfig()
  return authToken ? { Authorization: `Bearer ${authToken}` } : {}
}

// ── Event types ─────────────────────────────────────────────────────────────

export type TuiEvent =
  | { kind: 'delta'; content: string }
  | { kind: 'tool_start'; name: string; input: unknown }
  | { kind: 'tool_end'; name: string; output: unknown }
  | { kind: 'agent_end' }
  | { kind: 'user_message'; content: string }
  | { kind: 'response'; content: string }
  | { kind: 'system'; message: string }
  | { kind: 'error'; message: string }

interface AgentEvent {
  type: string
  delta?: string
  toolName?: string
  args?: unknown
  result?: { content: string; isError?: boolean }
}

function translateAgentEvent(raw: AgentEvent): TuiEvent | null {
  switch (raw.type) {
    case 'message_delta':
      return { kind: 'delta', content: raw.delta ?? '' }
    case 'tool_start':
      return { kind: 'tool_start', name: raw.toolName ?? 'unknown', input: raw.args }
    case 'tool_end':
      return { kind: 'tool_end', name: raw.toolName ?? 'unknown', output: raw.result?.content }
    case 'agent_end':
      return { kind: 'agent_end' }
    default:
      return null
  }
}

// ── SSE streaming chat ──────────────────────────────────────────────────────
// POST /v1/agent/stream — server sends SSE events:
//   event: agent_event  data: {type, ...}
//   event: done         data: {sessionId}
//   event: error        data: {error}
//   data: [DONE]        (terminal)

export interface StreamChatOpts {
  message: string
  sessionId?: string
  model?: string
  onDelta: (text: string) => void
  onEvent: (event: TuiEvent) => void
  onSessionId: (id: string) => void
  onDone: () => void
  onError: (err: Error) => void
}

export function streamChat(opts: StreamChatOpts): () => void {
  const controller = new AbortController()
  const { authToken } = getConfig()

  ;(async () => {
    try {
      const res = await fetch('/v1/agent/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          ...authHeaders(),
        },
        body: JSON.stringify({
          message: opts.message,
          sessionId: opts.sessionId,
          model: opts.model,
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        opts.onError(new Error(`HTTP ${res.status}`))
        return
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let currentType = 'message'

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentType = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            const data = line.slice(5).trim()

            if (data === '[DONE]') { opts.onDone(); return }

            if (currentType === 'done') {
              try {
                const parsed = JSON.parse(data) as { sessionId?: string }
                if (parsed.sessionId) opts.onSessionId(parsed.sessionId)
              } catch { /* ignore */ }
              currentType = 'message'
              continue
            }

            if (currentType === 'error') {
              try {
                const parsed = JSON.parse(data) as { error?: string }
                opts.onError(new Error(parsed.error ?? 'Stream error'))
              } catch { opts.onError(new Error(data)) }
              return
            }

            if (currentType === 'agent_event') {
              try {
                const raw = JSON.parse(data) as AgentEvent
                const event = translateAgentEvent(raw)
                if (event) {
                  if (event.kind === 'delta') opts.onDelta(event.content)
                  else opts.onEvent(event)
                }
              } catch { /* ignore */ }
            }

            currentType = 'message'
          } else if (line === '') {
            currentType = 'message'
          }
        }
      }
      opts.onDone()
    } catch (err) {
      if ((err as Error).name !== 'AbortError') opts.onError(err as Error)
    }
  })()

  return () => controller.abort()
}

// ── REST API helpers ────────────────────────────────────────────────────────

export interface Session {
  id: string
  title?: string
  created_at: string
  updated_at: string
  message_count?: number
}

export interface Agent {
  id: string
  name: string          // mapped from agent_name
  session_id?: string   // session this agent is bound to
  status: string
  lastActive?: string
}

export interface Run {
  id: string
  agentId?: string
  status: string
  durationMs?: number
  createdAt: string
}

export const api = {
  getSessions: (): Promise<Session[]> =>
    fetch('/v1/sessions', { headers: authHeaders() })
      .then(r => r.ok ? r.json() : { sessions: [] })
      .then((d: { sessions: Session[] }) => d.sessions ?? [])
      .catch(() => []),

  deleteSession: (id: string): Promise<void> =>
    fetch(`/v1/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    }).then(() => undefined).catch(() => undefined),

  getAgents: (): Promise<Agent[]> =>
    fetch('/v1/agents', { headers: authHeaders() })
      .then(r => r.ok ? r.json() : { agents: [] })
      .then((d: unknown) => {
        const raw: Record<string, unknown>[] = Array.isArray(d) ? d : ((d as { agents?: unknown[] }).agents ?? []) as Record<string, unknown>[]
        return raw.map(a => ({
          id: String(a.id ?? ''),
          name: String(a.agent_name ?? a.name ?? a.id ?? 'Agent'),
          session_id: a.session_id ? String(a.session_id) : undefined,
          status: String(a.status ?? 'idle'),
          lastActive: a.updated_at ? String(a.updated_at) : undefined,
        }))
      })
      .catch(() => []),

  getRuns: (): Promise<Run[]> =>
    fetch('/v1/runs', { headers: authHeaders() })
      .then(r => r.ok ? r.json() : [])
      .then((d: unknown) => Array.isArray(d) ? d : (d as { runs?: Run[] }).runs ?? [])
      .catch(() => []),

  getSessionMessages: (sessionId: string): Promise<{ role: string; content: string }[]> =>
    fetch(`/v1/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : { messages: [] })
      .then((d: { messages?: { role: string; content: string }[] }) => d.messages ?? [])
      .catch(() => []),

  getSessionMessagesRaw: (sessionId: string): Promise<{ status: number; msgs: { role: string; content: string }[] }> =>
    fetch(`/v1/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`, { headers: authHeaders() })
      .then(async r => ({ status: r.status, msgs: r.ok ? (await r.json()).messages ?? [] : [] }))
      .catch(() => ({ status: 0, msgs: [] })),

  // Create an agent record for a session (called after new session is created)
  createSessionAgent: (sessionId: string, templateName = 'base'): Promise<void> =>
    fetch(`/v1/sessions/${encodeURIComponent(sessionId)}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ template_name: templateName }),
    }).then(() => undefined).catch(() => undefined),
}

// ── Theme ──────────────────────────────────────────────────────
export type ThemeId = 'space-dark' | 'day-command' | 'deep-sea'

export function getTheme(): ThemeId {
  try {
    return (localStorage.getItem('gc_theme') as ThemeId) ?? 'space-dark'
  } catch {
    return 'space-dark'
  }
}

export function saveTheme(id: ThemeId): void {
  try {
    localStorage.setItem('gc_theme', id)
  } catch {
    // storage unavailable (Safari Private, sandboxed iframe) — theme still applies via DOM
  }
  document.documentElement.setAttribute('data-theme', id)
}
