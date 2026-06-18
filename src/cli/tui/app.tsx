// src/cli/tui/app.tsx
import React, { useCallback, useEffect, useReducer, useRef } from 'react'
import { render, Box, Text, useApp, useStdout, useStdin, useInput } from 'ink'
import { useTerminalMode } from './hooks/use-terminal-mode.js'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import os from 'os'
import yaml from 'js-yaml'
import { streamChat } from './sse-client.js'
import { Header } from './components/header.js'
import { MessageList } from './components/message-list.js'
import { Editor } from './components/editor.js'
import { tuiReducer, initialTuiState } from './state.js'
import type { TuiEvent } from './types.js'
import { getFileIndex } from '../../tools/file-index/index.js'
import { getOrStartLspClient, detectLanguageServer } from '../../tools/lsp/index.js'

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

export interface TuiOptions {
  model?: string
  sessionId?: string
}

function App({ srv, opts }: { srv: ServerConfig; opts: TuiOptions }) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const { stdin } = useStdin()
  const [state, dispatch] = useReducer(tuiReducer, initialTuiState({ sessionId: opts.sessionId }))
  useTerminalMode()

  // Global Ctrl+C / Ctrl+D handler — always active regardless of focus or isRunning.
  // useInput with isActive=true (default) intercepts before the Editor's own useInput.
  // Without this, focus={false} on Editor disables useInput there, making Ctrl+C a no-op.
  const cancelRef = useRef<(() => void) | null>(null)
  const isRunningRef = useRef(false)
  const exitRef = useRef(exit)
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startMsRef = useRef(0)
  // Accumulate delta content between React renders (throttle to 20fps)
  const pendingDeltaRef = useRef('')
  const lastDeltaFlushRef = useRef(0)

  // Keep refs in sync with latest state so the global handler closure is always fresh
  isRunningRef.current = state.isRunning
  exitRef.current = exit

  // Global Ctrl+C: always active (isActive not set = defaults to true).
  // Handles two cases: interrupt running agent, or exit when idle.
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (isRunningRef.current) {
        // Interrupt running agent
        if (cancelRef.current) cancelRef.current()
        if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); elapsedTimerRef.current = null }
        pendingDeltaRef.current = ''
        dispatch({ type: 'CANCEL' })
      } else {
        // Exit when idle (Editor's own onCancel also fires, but CANCEL is a no-op when idle)
        exitRef.current()
      }
    }
    if (key.ctrl && input === 'd' && !isRunningRef.current) {
      exitRef.current()
    }
  })

  // ── Resize ──────────────────────────────────────────────────────
  useEffect(() => {
    const handleResize = () =>
      dispatch({ type: 'RESIZE', rows: stdout.rows, columns: stdout.columns })
    stdout.on('resize', handleResize)
    return () => { stdout.off('resize', handleResize) }
  }, [stdout])

  // ── Mouse wheel (SGR mouse byte parsing) ────────────────────────
  useEffect(() => {
    if (!stdin) return
    const handleMouseData = (buf: Buffer) => {
      const str = buf.toString('utf-8')
      const sgrMouse = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/)
      if (!sgrMouse) return  // not a mouse event — let useInput handle it
      const button = parseInt(sgrMouse[1], 10)
      if (button === 64) dispatch({ type: 'SCROLL_UP', lines: 1 })
      if (button === 65) dispatch({ type: 'SCROLL_DOWN', lines: 1 })
    }
    stdin.on('data', handleMouseData)
    return () => { stdin.off('data', handleMouseData) }
  }, [stdin, dispatch])

  // ── Initial system messages + file index + LSP ──────────────────
  useEffect(() => {
    dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: `Connected to ${srv.baseUrl}` } })
    if (opts.sessionId) {
      dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: `Session: ${opts.sessionId}` } })
    }
    dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: 'Type a message and press Enter | /quit to exit | /help for commands' } })

    // File index
    ;(async () => {
      try {
        const { execSync } = await import('node:child_process')
        const workdir = process.cwd()
        let files: string[] = []
        try {
          const output = execSync('git ls-files', { cwd: workdir, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 })
          files = output.split('\n').filter(Boolean)
        } catch {
          const output = execSync('find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*"',
            { cwd: workdir, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 })
          files = output.split('\n').filter(Boolean).map(f => f.replace(/^\.\//, ''))
        }
        if (files.length > 0) getFileIndex().loadFromFileList(files)
      } catch { /* ignore */ }
    })()

    // LSP
    ;(async () => {
      try {
        const detected = detectLanguageServer(process.cwd())
        if (detected) {
          const client = await getOrStartLspClient(process.cwd())
          if (client?.isReady) {
            dispatch({
              type: 'SSE_EVENT',
              event: { kind: 'system', message: `LSP ready: ${client.serverName}` },
            })
          }
        }
      } catch { /* ignore */ }
    })()
  }, [])

  // ── Cleanup ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (cancelRef.current) cancelRef.current()
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current)
    }
  }, [])

  // ── Send message ─────────────────────────────────────────────────
  const sendMessage = useCallback((message: string) => {
    if (message === '/quit' || message === '/exit' || message === '/q') { exit(); return }
    if (message === '/clear') { dispatch({ type: 'CLEAR' }); return }
    if (message.startsWith('/session ')) {
      const sid = message.slice(9).trim()
      dispatch({ type: 'SESSION_ID', id: sid }); return
    }
    if (message === '/help') {
      dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: 'Commands: /quit /clear /session <id> /help' } }); return
    }
    if (state.isRunning) {
      dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: 'Agent is running — press Ctrl+C to interrupt' } }); return
    }

    dispatch({ type: 'SEND_MESSAGE', message })
    startMsRef.current = Date.now()

    elapsedTimerRef.current = setInterval(() => {
      dispatch({ type: 'TICK', elapsedMs: Date.now() - startMsRef.current })
    }, 500)

    cancelRef.current = streamChat({
      baseUrl: srv.baseUrl,
      message,
      sessionId: state.currentSessionId,
      model: opts.model,
      authToken: srv.authToken,
      attachments: state.inputAttachments,

      onEvent: (event: TuiEvent) => {
        if (event.kind === 'thinking_delta') {
          dispatch({ type: 'THINKING_DELTA', delta: event.delta, nowMs: Date.now() })
          return
        }
        if (event.kind === 'thinking_end') {
          dispatch({ type: 'THINKING_DONE', content: event.content, durationMs: event.durationMs })
          return
        }
        if (event.kind === 'delta') {
          // Throttle: accumulate deltas, flush at most every 50ms
          pendingDeltaRef.current += event.content
          const now = Date.now()
          if (now - lastDeltaFlushRef.current >= 50) {
            dispatch({ type: 'STREAM_DELTA', content: pendingDeltaRef.current })
            pendingDeltaRef.current = ''
            lastDeltaFlushRef.current = now
          }
          return
        }
        if (event.kind === 'turn_end') return  // handled by onDone flush

        if (event.kind === 'agent_end') {
          dispatch({ type: 'AGENT_END', model: event.model, usage: event.usage })
          return
        }

        dispatch({ type: 'SSE_EVENT', event })
      },

      onSessionId: (sid) => dispatch({ type: 'SESSION_ID', id: sid }),

      onDone: () => {
        if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); elapsedTimerRef.current = null }
        // Flush any remaining delta
        if (pendingDeltaRef.current) {
          dispatch({ type: 'STREAM_DELTA', content: pendingDeltaRef.current })
          pendingDeltaRef.current = ''
        }
        dispatch({ type: 'STREAM_DONE' })
      },

      onError: (err) => {
        if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); elapsedTimerRef.current = null }
        pendingDeltaRef.current = ''
        dispatch({ type: 'STREAM_ERROR', message: err.message })
      },
    })
  }, [state.isRunning, state.currentSessionId, srv, opts.model, exit])

  const { termSize, headerState, events, streamingContent, input, inputCursor, isRunning,
          thinkingContent, thinkingStartMs, thinkingDone, scrollOffset, inputAttachments } = state

  return (
    <Box flexDirection="column" height={termSize.rows}>
      <Box flexShrink={0}>
        <Header state={headerState} columns={termSize.columns} />
      </Box>
      {scrollOffset > 0 && (
        <Box flexShrink={0}>
          <Text dimColor>{'  ↑ scrolled '}{scrollOffset}{' lines — End key or send message to return'}</Text>
        </Box>
      )}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        <MessageList
          events={events}
          streamingContent={streamingContent}
          columns={termSize.columns}
          scrollOffset={scrollOffset}
          visibleRows={termSize.rows - 5}
          thinkingContent={thinkingContent}
          thinkingStartMs={thinkingStartMs}
          thinkingDone={thinkingDone}
          elapsedMs={headerState.elapsedMs ?? 0}
          dispatch={dispatch}
        />
      </Box>
      <Box flexShrink={0}>
      <Editor
        value={input}
        cursor={inputCursor}
        columns={termSize.columns}
        focus={!isRunning}
        dispatch={dispatch}
        onSubmit={sendMessage}
        onCancel={() => {
          if (cancelRef.current) cancelRef.current()
          dispatch({ type: 'CANCEL' })
        }}
        onExit={exit}
        attachments={inputAttachments}
        onScrollUp={() => dispatch({ type: 'SCROLL_UP', lines: 10 })}
        onScrollDown={() => dispatch({ type: 'SCROLL_DOWN', lines: 10 })}
        onScrollToBottom={() => dispatch({ type: 'SCROLL_TO_BOTTOM' })}
        isRunning={isRunning}
        currentTool={headerState.currentTool}
      />
      </Box>
    </Box>
  )
}

export async function runTui(opts: TuiOptions = {}): Promise<void> {
  const srv = loadServerConfig()
  const { waitUntilExit } = render(<App srv={srv} opts={opts} />, { exitOnCtrlC: false })
  await waitUntilExit()
}
