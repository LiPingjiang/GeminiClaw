// src/cli/tui/components/message-list.tsx
// Virtual scroll: all events pre-rendered to ANSI lines, then sliced to viewport.
// No more marginTop hack. Only visible lines reach the screen buffer.

import React, { useMemo } from 'react'
import { AnsiBlock } from '../gc-renderer/index.js'
import { renderEventToAnsiLines, renderThinkingLine } from '../lib/event-renderer.js'
import { markdownToAnsiLines } from '../lib/ansi-markdown.js'
import type { TuiEvent } from '../types.js'
import type { TuiAction } from '../state.js'
import { useAnimationFrame } from '../gc-renderer/index.js'

type Dispatch = React.Dispatch<TuiAction>

interface MessageListProps {
  events: TuiEvent[]
  streamingContent: string
  columns: number
  scrollOffset: number
  visibleRows: number
  thinkingContent: string
  thinkingStartMs: number
  thinkingDone: boolean
  elapsedMs: number
  dispatch: Dispatch
}

export function MessageList({
  events, streamingContent, columns,
  scrollOffset, visibleRows,
  thinkingContent, thinkingStartMs, thinkingDone, elapsedMs,
  dispatch,
}: MessageListProps) {
  // Animation tick — forces re-render for spinner animation
  useAnimationFrame()

  const isThinking = thinkingContent.length > 0 && !thinkingDone

  // ── Pre-render all events to ANSI lines (memoized) ─────────────────────────
  const eventLines = useMemo(() =>
    events
      .filter(e => e.kind !== 'delta' && e.kind !== 'turn_end' && e.kind !== 'thinking_delta')
      .flatMap(e => renderEventToAnsiLines(e, columns))
  , [events, columns])

  // ── Streaming suffix (re-renders every tick) ────────────────────────────────
  const streamLines = useMemo(() =>
    streamingContent && !isThinking
      ? markdownToAnsiLines(streamingContent, columns - 2).map(l => '  ' + l)
      : []
  , [streamingContent, isThinking, columns])

  // ── Thinking spinner (single line) ─────────────────────────────────────────
  const thinkingLine = isThinking
    ? renderThinkingLine(isThinking, elapsedMs, thinkingStartMs)
    : ''

  // ── Combine all lines ────────────────────────────────────────────────────────
  const allLines = [
    ...eventLines,
    ...streamLines,
    ...(thinkingLine ? [thinkingLine] : []),
  ]

  const totalLines = allLines.length
  const maxScroll  = Math.max(0, totalLines - visibleRows)

  // Update max scroll offset whenever total changes
  // We use a ref-style approach to avoid dispatching on every render
  React.useEffect(() => {
    dispatch({ type: 'SET_MAX_SCROLL_OFFSET', value: maxScroll })
  }, [maxScroll, dispatch])

  // ── Slice to viewport ────────────────────────────────────────────────────────
  const clampedScroll = Math.min(scrollOffset, maxScroll)
  const start = Math.max(0, totalLines - visibleRows - clampedScroll)
  const visibleLines = allLines.slice(start, start + visibleRows)

  return (
    <AnsiBlock lines={visibleLines} width={columns} />
  )
}
