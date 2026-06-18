// src/cli/tui/components/message-list.tsx
import React from 'react'
import { Box } from 'ink'
import { MessageItem } from './message-item.js'
import { StreamingMd } from './streaming-md.js'
import { ThinkingLine } from './thinking-line.js'
import type { TuiEvent } from '../types.js'

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
}

export function MessageList({
  events, streamingContent, columns,
  scrollOffset, visibleRows,
  thinkingContent, thinkingStartMs, thinkingDone, elapsedMs,
}: MessageListProps) {
  const allItems: TuiEvent[] = [
    ...events.filter(e => e.kind !== 'delta' && e.kind !== 'turn_end' && e.kind !== 'thinking_delta'),
    ...(streamingContent ? [{ kind: 'response' as const, content: streamingContent }] : []),
  ]

  const endIdx = allItems.length
  const startIdx = Math.max(0, endIdx - visibleRows - scrollOffset)
  const rawEnd = endIdx - scrollOffset
  const endSlice = scrollOffset > 0 ? Math.max(0, rawEnd) : undefined
  const visibleItems = allItems.slice(startIdx, endSlice)

  const isThinking = thinkingContent.length > 0 && !thinkingDone

  return (
    <Box flexDirection="column" flexGrow={1}>
      {scrollOffset > 0 && (
        <Box>
          <Box>
            {/* scroll indicator handled in app.tsx layout */}
          </Box>
        </Box>
      )}
      {visibleItems.map((event, i) => (
        <MessageItem key={i} event={event} />
      ))}
      {isThinking && (
        <ThinkingLine
          elapsedMs={elapsedMs}
          thinkingStartMs={thinkingStartMs}
          isStreaming={isThinking}
        />
      )}
    </Box>
  )
}
