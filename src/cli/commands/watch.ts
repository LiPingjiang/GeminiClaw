// src/cli/commands/watch.ts
/**
 * gc watch — realtime agent conversation monitor
 *
 * Connects to /v1/trace/live SSE and renders each event with color formatting.
 *
 * Usage:
 *   gc watch                       # all sessions, live
 *   gc watch <sessionId>           # filter by session prefix
 *   gc watch --tail                # last 50 events + live
 *   gc watch --json                # raw JSONL output
 *   gc watch --url http://...      # custom server URL
 */

import type { Command } from 'commander'
import * as http from 'node:http'
import * as https from 'node:https'
import { URL } from 'node:url'

const DEFAULT_URL = 'http://localhost:18888'

// ANSI color helpers
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  italic:  '\x1b[3m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false })
}

function fmtBytes(n: number): string {
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${n}B`
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function fmtSession(sessionId: string): string {
  return sessionId.slice(0, 6)
}

interface TraceEvent {
  ts: number
  sessionId: string
  requestId?: string
  userId?: string
  agentEvent: Record<string, unknown>
}

function renderEvent(event: TraceEvent): string {
  const t = fmtTime(event.ts)
  const sess = `${C.dim}${fmtSession(event.sessionId)}${C.reset}`
  const ae = event.agentEvent
  const type = ae['type'] as string

  switch (type) {
    case 'user_message': {
      const content = String(ae['content'] ?? '').slice(0, 120)
      return `${t} ${sess}  ${C.bold}USER  ${C.reset}${C.bold}❯ ${content}${C.reset}`
    }
    case 'llm_request': {
      const model = String(ae['model'] ?? '?')
      const msgs = ae['messageCount'] ?? '?'
      return `${t} ${sess}  ${C.dim}LLM   → ${model} (${msgs} msgs)${C.reset}`
    }
    case 'thinking_delta': {
      const delta = String(ae['delta'] ?? '').slice(0, 80)
      return `${t} ${sess}  ${C.dim}${C.italic}THINK ∴ ${delta}…${C.reset}`
    }
    case 'thinking_end': {
      const ms = Number(ae['durationMs'] ?? 0)
      return `${t} ${sess}  ${C.dim}${C.italic}THINK ∴ done (${(ms/1000).toFixed(1)}s)${C.reset}`
    }
    case 'turn_start': {
      const turn = ae['turn'] ?? '?'
      return `${t} ${sess}  ${C.dim}TURN  ${turn}${C.reset}`
    }
    case 'tool_start': {
      const name = String(ae['toolName'] ?? '?')
      const args = JSON.stringify(ae['args'] ?? {}).slice(0, 80)
      return `${t} ${sess}  ${C.magenta}TOOL  ⬡ ${name}${C.reset}${C.dim}  ${args}${C.reset}`
    }
    case 'tool_end': {
      const name = String(ae['toolName'] ?? '?')
      const ms = Number(ae['durationMs'] ?? 0)
      const isErr = Boolean(ae['isError'])
      const resultPreview = String(ae['resultPreview'] ?? '').slice(0, 60)
      const msStr = ms >= 1000 ? `${(ms/1000).toFixed(1)}s` : `${ms}ms`
      if (isErr) {
        return `${t} ${sess}  ${C.red}TOOL  ✗ ${name}  ${msStr}  ${resultPreview}${C.reset}`
      }
      const sizeStr = resultPreview.length > 0 ? `  ${fmtBytes(resultPreview.length)}` : ''
      return `${t} ${sess}  ${C.green}${C.dim}TOOL  ✓ ${name}  ${msStr}${sizeStr}${C.reset}`
    }
    case 'message_delta': {
      const delta = String(ae['delta'] ?? '').slice(0, 100)
      return `${t} ${sess}  ${C.green}REPLY ● ${delta}${C.reset}`
    }
    case 'agent_end': {
      const turns = ae['totalTurns'] ?? '?'
      const reason = ae['stopReason'] ?? '?'
      const usage = ae['usage'] as Record<string, number> | undefined
      const tokStr = usage
        ? `in:${fmtTokens(usage['inputTokens'] ?? 0)} out:${fmtTokens(usage['outputTokens'] ?? 0)} cache:${fmtTokens(usage['cacheReadInputTokens'] ?? 0)}`
        : ''
      return `${t} ${sess}  ${C.dim}END   ✓ ${turns}t · ${reason}${tokStr ? ' · ' + tokStr : ''}${C.reset}`
    }
    case 'error': {
      const msg = String(ae['message'] ?? '?').slice(0, 120)
      return `${t} ${sess}  ${C.red}${C.bold}ERROR ✗ ${msg}${C.reset}`
    }
    default:
      return `${t} ${sess}  ${C.dim}${type}  ${JSON.stringify(ae).slice(0, 80)}${C.reset}`
  }
}

function connectAndWatch(opts: {
  baseUrl: string
  session?: string
  tail: boolean
  json: boolean
}): void {
  const { baseUrl, session, tail, json } = opts

  const url = new URL('/v1/trace/live', baseUrl)
  if (session) url.searchParams.set('session', session)
  if (tail) url.searchParams.set('tail', '50')

  const transport = url.protocol === 'https:' ? https : http
  let reconnectDelay = 1000

  function connect(): void {
    if (!json) {
      process.stdout.write(`${C.dim}Connecting to ${url}…${C.reset}\n`)
    }

    const req = transport.get(url.toString(), {
      headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
    }, (res) => {
      if (res.statusCode !== 200) {
        process.stderr.write(`Error: HTTP ${res.statusCode}\n`)
        setTimeout(connect, reconnectDelay)
        return
      }
      reconnectDelay = 1000  // reset on success
      let buf = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => {
        buf += chunk
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (!data) continue
          try {
            const event = JSON.parse(data) as TraceEvent
            if (json) {
              process.stdout.write(data + '\n')
            } else {
              process.stdout.write(renderEvent(event) + '\n')
            }
          } catch { /* skip malformed */ }
        }
      })
      res.on('end', () => {
        if (!json) process.stdout.write(`${C.dim}Disconnected. Reconnecting in ${reconnectDelay/1000}s…${C.reset}\n`)
        setTimeout(connect, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
      })
    })

    req.on('error', (err) => {
      process.stderr.write(`Connection error: ${err.message}\n`)
      setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
    })
  }

  connect()

  // Ctrl+C handler
  process.on('SIGINT', () => {
    if (!json) process.stdout.write('\nExiting.\n')
    process.exit(0)
  })

  // Keep process alive
  setInterval(() => {}, 60_000)
}

export function registerWatchCommand(program: Command): void {
  program
    .command('watch [sessionId]')
    .description('Watch agent conversations in real-time')
    .option('--url <url>', 'Server URL', DEFAULT_URL)
    .option('--tail', 'Replay last 50 events before streaming live')
    .option('--json', 'Output raw JSONL instead of formatted text')
    .action((sessionId: string | undefined, options: { url: string; tail: boolean; json: boolean }) => {
      connectAndWatch({
        baseUrl: options.url,
        session: sessionId,
        tail: options.tail ?? false,
        json: options.json ?? false,
      })
    })
}
