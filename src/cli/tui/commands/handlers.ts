// src/cli/tui/commands/handlers.ts
import { execSync } from 'node:child_process'
import { streamChat } from '../sse-client.js'
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
