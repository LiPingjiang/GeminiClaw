import React from 'react'
import { Box, Text } from '../gc-renderer/index.js'
import { useTextInput } from '../hooks/use-text-input.js'
import type { TuiAction, InputAttachment, BtwPhase } from '../state.js'
import type { TuiCommand } from '../commands/registry.js'

export interface EditorProps {
  value: string
  cursor: number
  columns: number
  focus: boolean
  dispatch: React.Dispatch<TuiAction>
  onSubmit: (message: string) => void
  onCancel: () => void
  onExit: () => void
  attachments: InputAttachment[]
  onScrollUp: () => void
  onScrollDown: () => void
  onScrollToBottom: () => void
  isRunning: boolean
  currentTool?: string
  suggestions: TuiCommand[]
  selectedSuggestion: number
  onHistoryUp: () => void
  onHistoryDown: () => void
  btwState?: BtwPhase
  onBtwScrollUp?: () => void
  onBtwScrollDown?: () => void
  onBtwClose?: () => void
  elapsedMs?: number
  totalOutputTokens?: number
}

const PROMPT = '> '
const PROMPT_WIDTH = 2 // '> ' is 2 columns wide

export function Editor({ value, cursor, columns, focus, dispatch, onSubmit, onCancel, onExit, attachments, onScrollUp, onScrollDown, onScrollToBottom, isRunning, currentTool, suggestions, selectedSuggestion, onHistoryUp, onHistoryDown, btwState, onBtwScrollUp, onBtwScrollDown, onBtwClose, elapsedMs, totalOutputTokens }: EditorProps) {
  const inputCols = Math.max(1, columns - PROMPT_WIDTH)

  const { rendered } = useTextInput({
    value,
    cursor,
    columns: inputCols,
    focus,
    onChange: (newVal, newCur) => dispatch({ type: 'INPUT_CHANGE', value: newVal, cursor: newCur }),
    onSubmit: (msg: string) => {
      if (suggestions.length > 0 && selectedSuggestion >= 0) {
        const cmd = suggestions[selectedSuggestion]
        if (cmd) {
          if (cmd.argHint) {
            // Complete to prefix, don't submit yet
            const newVal = cmd.prefix + ' '
            dispatch({ type: 'INPUT_CHANGE', value: newVal, cursor: newVal.length })
            dispatch({ type: 'SUGGESTION_CLEAR' })
            return
          } else {
            // No args — submit immediately with just the prefix
            dispatch({ type: 'SUGGESTION_CLEAR' })
            onSubmit(cmd.prefix)
            return
          }
        }
      }
      onSubmit(msg)
    },
    onHistoryUp: onHistoryUp,
    onHistoryDown: onHistoryDown,
    onCancel,
    onExit,
    onEscape: () => {
      if (btwState && btwState.phase !== 'idle') {
        onBtwClose?.()
        return
      }
      if (suggestions.length > 0) {
        dispatch({ type: 'SUGGESTION_CLEAR' })
        return
      }
      if (value === '' && attachments.length > 0) {
        dispatch({ type: 'INPUT_CLEAR_ATTACHMENTS' })
      }
    },
    onTab: () => {
      if (suggestions.length > 0 && selectedSuggestion >= 0) {
        const cmd = suggestions[selectedSuggestion]
        if (cmd) {
          const newVal = cmd.argHint ? cmd.prefix + ' ' : cmd.prefix
          dispatch({ type: 'INPUT_CHANGE', value: newVal, cursor: newVal.length })
          dispatch({ type: 'SUGGESTION_CLEAR' })
        }
      }
    },
    onScrollUp: btwState && btwState.phase !== 'idle' ? (onBtwScrollUp ?? onScrollUp) : onScrollUp,
    onScrollDown: btwState && btwState.phase !== 'idle' ? (onBtwScrollDown ?? onScrollDown) : onScrollDown,
    onScrollToBottom,
  })

  if (!focus) {
    return (
      <>
        <Text dimColor>{'─'.repeat(columns)}</Text>
        <Box>
          <Text color="gray" bold>{PROMPT}</Text>
          <Text dimColor>{value || 'waiting for agent...'}</Text>
        </Box>
      </>
    )
  }

  return (
    <>
      <Text dimColor>{'─'.repeat(columns)}</Text>
      <Box flexDirection="column">
        {attachments.length > 0 && (
          <Box>
            {attachments.map((a, i) => (
              <Text key={i} dimColor>{' [🖼 '}{a.filename}{' '}{formatBytes(a.sizeBytes)}{']'}</Text>
            ))}
            <Text dimColor>{'  · Esc to clear'}</Text>
          </Box>
        )}
        <Box>
          <Text color="yellow" bold>{PROMPT}</Text>
          {/* rendered contains ANSI escape sequences for cursor highlight */}
          <Text>{rendered}</Text>
        </Box>
        <StatusBar
          focus={focus}
          isRunning={isRunning}
          currentTool={currentTool}
          inputEmpty={value === ''}
          inputIsCommand={value.startsWith('/')}
          columns={columns}
          elapsedMs={elapsedMs}
          totalOutputTokens={totalOutputTokens}
        />
      </Box>
    </>
  )
}

// ── Spinner constants (matching Claude Code's style) ──────────────────────────

const SPINNER_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽']
const SPINNER_GLYPHS_REV = [...SPINNER_GLYPHS].reverse()
const SPINNER_CYCLE = [...SPINNER_GLYPHS, ...SPINNER_GLYPHS_REV]

const SPINNER_VERBS = [
  'Thinking', 'Working', 'Analyzing', 'Computing', 'Reasoning',
  'Processing', 'Generating', 'Synthesizing', 'Orchestrating', 'Evaluating',
  'Crunching', 'Deliberating', 'Calculating', 'Crafting', 'Pondering',
  'Puttering', 'Musing', 'Ruminating', 'Cogitating', 'Scheming',
  'Wrangling', 'Tinkering', 'Brewing', 'Cooking', 'Forging',
]

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function StatusBar({
  focus,
  isRunning,
  currentTool,
  inputEmpty,
  inputIsCommand,
  columns,
  elapsedMs = 0,
  totalOutputTokens = 0,
}: {
  focus: boolean
  isRunning: boolean
  currentTool?: string
  inputEmpty: boolean
  inputIsCommand: boolean
  columns: number
  elapsedMs?: number
  totalOutputTokens?: number
}) {
  const [frame, setFrame] = React.useState(0)
  const [verbIdx, setVerbIdx] = React.useState(0)

  React.useEffect(() => {
    if (!isRunning) return
    const glyphTimer = setInterval(() => setFrame(f => (f + 1) % SPINNER_CYCLE.length), 120)
    const verbTimer  = setInterval(() => setVerbIdx(i => (i + 1) % SPINNER_VERBS.length), 2000)
    return () => { clearInterval(glyphTimer); clearInterval(verbTimer) }
  }, [isRunning])

  if (!focus) return null

  if (isRunning) {
    const glyph  = SPINNER_CYCLE[frame % SPINNER_CYCLE.length] ?? '✻'
    const verb   = SPINNER_VERBS[verbIdx % SPINNER_VERBS.length] ?? 'Working'
    const label  = currentTool ? `${glyph} ${currentTool}…` : `${glyph} ${verb}…`
    const timeStr  = elapsedMs > 0 ? formatDuration(elapsedMs) : ''
    const tokenStr = totalOutputTokens > 0 ? `↓ ${formatTokens(totalOutputTokens)} tokens` : ''
    const parts = [timeStr, tokenStr].filter(Boolean)
    const suffix = parts.length > 0 ? ` (${parts.join(' · ')})` : ''

    return (
      <Box justifyContent="space-between">
        <Text color="green">{label}</Text>
        <Text dimColor>{suffix}{'  esc to interrupt'}</Text>
      </Box>
    )
  }

  if (inputIsCommand) {
    return (
      <Box>
        <Text dimColor>{'  ↑↓ select  Tab complete  Esc close'}</Text>
      </Box>
    )
  }

  if (!inputEmpty) {
    return (
      <Box justifyContent="flex-end">
        <Text dimColor>{'Enter send  Shift+Enter newline  '}</Text>
      </Box>
    )
  }

  return (
    <Box justifyContent="space-between">
      <Text dimColor>{'  /btw · /clear · /model · /help'}</Text>
      <Text dimColor>{'? for commands  '}</Text>
    </Box>
  )
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${n}B`
}
