// src/cli/tui/components/message-item.tsx
import React from 'react'
import { Box, Text } from 'ink'
import type { TuiEvent } from '../types.js'
import { DiffView } from './diff-view.js'

interface MessageItemProps {
  event: TuiEvent
}

export function MessageItem({ event }: MessageItemProps) {
  switch (event.kind) {
    case 'user_message':
      return (
        <Box marginTop={1}>
          <Text bold>{'❯ '}</Text>
          <Text bold>{event.content}</Text>
        </Box>
      )

    case 'response':
      return (
        <Box marginTop={1} paddingLeft={2}>
          <Text>{event.content}</Text>
        </Box>
      )

    case 'tool_start':
      return (
        <Box marginTop={1}>
          <Text color="magenta" dimColor>{'⬡ '}</Text>
          <Text color="magenta" dimColor bold>{event.name}</Text>
          <Text dimColor>{' ('}{JSON.stringify(event.args).slice(0, 80)}{')'}</Text>
        </Box>
      )

    case 'tool_end':
      return (
        <Box paddingLeft={2}>
          <Text color={event.isError ? 'red' : 'green'} dimColor>
            {event.isError ? '✗' : '✓'}{' '}{event.name}{' '}{event.durationMs}ms
          </Text>
        </Box>
      )

    case 'thinking_end':
      return (
        <Box marginTop={1}>
          <Text dimColor italic>{'∴ Thought for '}{Math.round(event.durationMs / 1000)}{'s'}</Text>
        </Box>
      )

    case 'agent_end':
      return (
        <Box marginTop={1}>
          <Text dimColor>
            {'✓ '}{event.totalTurns}{' turns · '}{event.stopReason}
            {event.usage ? ` · in:${fmtTokens(event.usage.inputTokens)} out:${fmtTokens(event.usage.outputTokens)}` : ''}
          </Text>
        </Box>
      )

    case 'error':
      return (
        <Box>
          <Text color="red">{'✗ '}{event.message}</Text>
        </Box>
      )

    case 'system':
      return event.message ? (
        <Box>
          <Text dimColor>{event.message}</Text>
        </Box>
      ) : null

    case 'guardrail_warn':
      return (
        <Box>
          <Text color="yellow" dimColor>{'⚠ ['}{event.toolName}{']: '}{event.message}</Text>
        </Box>
      )

    case 'guardrail_halt':
      return (
        <Box>
          <Text color="red">{'✗ HALT ['}{event.toolName}{']: '}{event.message}</Text>
        </Box>
      )

    case 'turn_start':
      return null

    case 'diff':
      return (
        <Box marginTop={1}>
          <DiffView filename={event.filename} before={event.before} after={event.after} columns={80} />
        </Box>
      )

    case 'delta':
    case 'turn_end':
    case 'thinking_delta':
      return null

    default:
      return null
  }
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}
