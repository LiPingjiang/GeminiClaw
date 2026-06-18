import React, { useEffect } from 'react'
import { Box } from 'ink'
import { MessageItem } from './message-item.js'
import { ThinkingLine } from './thinking-line.js'
import type { TuiEvent } from '../types.js'
import type { TuiAction } from '../state.js'

// Re-export TuiAction for convenience — MessageList dispatches SET_MAX_SCROLL_OFFSET
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
  const allItems: TuiEvent[] = [
    ...events.filter(e =>
      e.kind !== 'delta' && e.kind !== 'turn_end' && e.kind !== 'thinking_delta'
    ),
    ...(streamingContent ? [{ kind: 'response' as const, content: streamingContent }] : []),
  ]

  const isThinking = thinkingContent.length > 0 && !thinkingDone

  // Estimate content height: 1.5 rows per item (accounts for wrapped text, tool output)
  const estimatedContentHeight = Math.ceil(allItems.length * 1.5) + (isThinking ? 1 : 0)
  const maxScroll = Math.max(0, estimatedContentHeight - visibleRows)

  useEffect(() => {
    dispatch({ type: 'SET_MAX_SCROLL_OFFSET', value: maxScroll })
  }, [maxScroll, dispatch])

  return (
    <Box height={visibleRows} overflowY="hidden">
      <Box flexDirection="column" marginTop={-scrollOffset}>
        {allItems.map((event, i) => (
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
    </Box>
  )
}
