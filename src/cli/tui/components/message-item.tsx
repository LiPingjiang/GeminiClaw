// src/cli/tui/components/message-item.tsx
import React from 'react'
import { Box, Text } from 'ink'
import type { TuiEvent } from '../types.js'
import { DiffView } from './diff-view.js'
import { renderMarkdown } from '../lib/markdown-render.js'

const TOOL_RESULT_PREVIEW_LEN = 200
const COLUMNS_DEFAULT = 80

interface MessageItemProps {
  event: TuiEvent
  columns?: number
}

export function MessageItem({ event, columns = COLUMNS_DEFAULT }: MessageItemProps) {
  switch (event.kind) {
    case 'user_message':
      return (
        <Box marginTop={1}>
          <Text bold color="yellow">{'❯ '}</Text>
          <Text bold wrap="wrap">{event.content}</Text>
        </Box>
      )

    case 'response':
      return (
        <Box marginTop={1} paddingLeft={2} flexDirection="column">
          {renderMarkdown(event.content, columns - 2)}
        </Box>
      )

    case 'tool_start':
      return (
        <Box marginTop={1}>
          <Text color="magenta" dimColor>{'⬡ '}</Text>
          <Text color="magenta" bold>{event.name}</Text>
          <Text dimColor>{' '}{formatArgs(event.args)}</Text>
        </Box>
      )

    case 'tool_end':
      return <ToolEndItem event={event} />

    case 'thinking_end':
      return <ThinkingEndItem event={event} columns={columns} />

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
        <Box marginTop={1}>
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
          <DiffView filename={event.filename} before={event.before} after={event.after} columns={columns} />
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

/** Collapsible tool_end: short results inline, long results folded. */
function ToolEndItem({ event }: { event: Extract<TuiEvent, { kind: 'tool_end' }> }) {
  const isLong = (event.result?.length ?? 0) > TOOL_RESULT_PREVIEW_LEN

  return (
    <Box paddingLeft={2} flexDirection="column">
      <Box>
        <Text color={event.isError ? 'red' : 'green'} dimColor>
          {event.isError ? '✗' : '✓'}{' '}{event.name}{' '}{event.durationMs}ms
        </Text>
        {isLong && (
          <Text dimColor>
            {' '}
            <Text
              color="cyan"
              underline
              // Ink 7 doesn't have onClick; use a visual hint instead
            >
              {'▶ expand'}
            </Text>
          </Text>
        )}
      </Box>
      {event.result && (
        <Box paddingLeft={2}>
          <Text dimColor wrap="wrap">
            {isLong
              ? event.result.slice(0, TOOL_RESULT_PREVIEW_LEN) + '…'
              : event.result}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/** thinking_end: always show "∴ Thought for Xs" + first 300 chars of content. */
function ThinkingEndItem({
  event,
  columns,
}: {
  event: Extract<TuiEvent, { kind: 'thinking_end' }>
  columns: number
}) {
  const seconds = Math.max(1, Math.round(event.durationMs / 1000))
  const preview = event.content
    ? event.content.length > 300
      ? event.content.slice(0, 300) + '…'
      : event.content
    : null

  return (
    <Box marginTop={1} flexDirection="column">
      <Text dimColor italic>{'∴ Thought for '}{seconds}{'s'}</Text>
      {preview && (
        <Box paddingLeft={2} marginTop={1} flexDirection="column">
          {renderMarkdown(preview, columns - 2)}
        </Box>
      )}
    </Box>
  )
}

function formatArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const s = JSON.stringify(args)
  return s.length > 120 ? s.slice(0, 120) + '…' : s
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
