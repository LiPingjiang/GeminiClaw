// src/cli/tui/commands/handlers.ts
import { execSync } from 'node:child_process'
import { streamChat } from '../sse-client.js'
import { saveLastSessionId } from '../session-store.js'
import type { CommandContext } from './registry.js'

export function btwHandler(question: string, ctx: CommandContext): void {
  if (!question.trim()) {
    ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: 'Usage: /btw <question>' } })
    return
  }

  const sessionId = `btw-${Math.random().toString(36).slice(2, 10)}`

  const cancelFn = streamChat({
    baseUrl: ctx.baseUrl,
    authToken: ctx.authToken,
    message: question,
    sessionId,
    ephemeral: true,
    onEvent: (event) => {
      if (event.kind === 'delta') {
        ctx.dispatch({ type: 'BTW_DELTA', content: event.content })
      }
    },
    onSessionId: () => {},
    onDone: () => ctx.dispatch({ type: 'BTW_DONE' }),
    onError: () => ctx.dispatch({ type: 'BTW_DONE' }),
  })

  ctx.setBtwCancel?.(cancelFn)
  ctx.dispatch({ type: 'BTW_START', question })
}

export function bgHandler(message: string, ctx: CommandContext): void {
  if (!message.trim()) {
    ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: 'Usage: /bg <message>' } })
    return
  }

  ctx.dispatch({ type: 'BG_START' })

  streamChat({
    baseUrl: ctx.baseUrl,
    authToken: ctx.authToken,
    message,
    onEvent: (event) => {
      if (event.kind === 'delta') {
        ctx.dispatch({ type: 'BG_DELTA', content: event.content })
      }
    },
    onSessionId: () => {},
    onDone: () => ctx.dispatch({ type: 'BG_DONE' }),
    onError: () => ctx.dispatch({ type: 'BG_DONE' }),
  })
}

export function copyHandler(events: import('../types.js').TuiEvent[], ctx: CommandContext): void {
  // Find the last response event
  const last = [...events].reverse().find(e => e.kind === 'response')
  if (!last || last.kind !== 'response') {
    ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: '(nothing to copy)' } })
    return
  }

  if (process.platform !== 'darwin') {
    // Skip silently on non-macOS
    return
  }

  try {
    execSync('pbcopy', { input: last.content, encoding: 'utf-8' })
    ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: 'Copied to clipboard.' } })
  } catch {
    // Silently ignore pbcopy failures
  }
}

export function sessionHandler(args: string, ctx: CommandContext): void {
  const id = args.trim()

  if (!id) {
    // List recent sessions
    fetch(`${ctx.baseUrl}/v1/sessions?limit=5`, {
      headers: ctx.authToken ? { Authorization: `Bearer ${ctx.authToken}` } : {},
    })
      .then(r => r.ok ? r.json() : null)
      .then((data: any) => {
        if (!data?.sessions?.length) {
          ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: 'No sessions found.' } })
          return
        }
        const lines = data.sessions.map((s: any) => {
          const date = s.updated_at?.slice(0, 10) ?? '?'
          const msgs = s.message_count ?? 0
          const title = s.title ? ` "${s.title}"` : ''
          return `  ${s.id.slice(0, 8)}  ${date}  ${msgs} msgs${title}`
        })
        ctx.dispatch({
          type: 'SSE_EVENT',
          event: { kind: 'system', message: `Sessions:\n${lines.join('\n')}\n(type /session <id> to switch)` },
        })
      })
      .catch(() => ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: 'Could not fetch sessions.' } }))
    return
  }

  // Switch to session — clear events, load history
  ctx.dispatch({ type: 'CLEAR' })
  ctx.dispatch({ type: 'SESSION_ID', id })

  fetch(`${ctx.baseUrl}/v1/sessions/${encodeURIComponent(id)}/messages?limit=30`, {
    headers: ctx.authToken ? { Authorization: `Bearer ${ctx.authToken}` } : {},
  })
    .then(r => r.ok ? r.json() : null)
    .then((data: any) => {
      if (!data?.messages?.length) {
        ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: `Session ${id.slice(0, 8)} — no history.` } })
        return
      }
      const historyEvents = data.messages
        .filter((m: any) => m.role === 'user' || m.role === 'assistant')
        .map((m: any) => m.role === 'user'
          ? { kind: 'user_message' as const, content: String(m.content ?? '') }
          : { kind: 'response' as const, content: String(m.content ?? '') }
        )
      ctx.dispatch({ type: 'LOAD_HISTORY', events: historyEvents })
      ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: `↺ Switched to session ${id.slice(0, 8)}, loaded ${historyEvents.length} messages` } })

      // Persist as last session
      saveLastSessionId(id)
    })
    .catch(() => ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: `Session ${id.slice(0, 8)} not found.` } }))
}
