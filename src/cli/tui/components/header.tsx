// src/cli/tui/components/header.tsx
import React from 'react'
import { Box, Text } from '../../../ink.js'
import type { HeaderState } from '../types.js'

interface HeaderProps {
  state: HeaderState
  columns: number
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

function shortenModel(model?: string): string {
  if (!model) return ''
  const name = model.split('/').at(-1) ?? model
  return name.length > 22 ? name.slice(0, 19) + '…' : name
}

export function Header({ state, columns }: HeaderProps) {
  const dot = state.status === 'running' ? '●' : state.status === 'error' ? '✕' : '○'
  const dotColor = state.status === 'running' ? 'green' : state.status === 'error' ? 'red' : 'gray'
  const modelStr = shortenModel(state.model)
  const thinkingIndicator = state.thinkingEnabled ? ' ∴' : ''
  const separator = '─'.repeat(Math.max(0, columns))
  const totalTokens = (state.totalInputTokens ?? 0) + (state.totalOutputTokens ?? 0)

  return (
    <Box flexDirection="column">
      {/* Top line */}
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text bold color="cyan">GeminiClaw</Text>
          {modelStr && <Text dimColor>{modelStr}{thinkingIndicator}</Text>}
          {state.turn !== undefined && <Text dimColor>T{state.turn}</Text>}
          {state.currentTool && <Text color="yellow" dimColor>⚡{state.currentTool}</Text>}
        </Box>
        <Box gap={1}>
          {state.elapsedMs !== undefined && state.elapsedMs > 0 && (
            <Text dimColor>{fmtMs(state.elapsedMs)}</Text>
          )}
          <Text color={dotColor} bold>{dot}</Text>
        </Box>
      </Box>
      {/* Separator */}
      <Text dimColor>{separator}</Text>
      {/* Stats line */}
      <Box justifyContent="space-between">
        <Box gap={1}>
          {totalTokens > 0 ? (
            <>
              <Text dimColor>in:{fmtTokens(state.totalInputTokens ?? 0)}</Text>
              <Text dimColor>out:{fmtTokens(state.totalOutputTokens ?? 0)}</Text>
              {(state.totalCacheReadTokens ?? 0) > 0 && (
                <Text dimColor>cache:{fmtTokens(state.totalCacheReadTokens ?? 0)}</Text>
              )}
            </>
          ) : (
            <Text dimColor>Ready</Text>
          )}
        </Box>
        <Box gap={1}>
          {state.sessionId && <Text dimColor>sess:{state.sessionId.slice(0, 8)}</Text>}
          {state.fileIndexSize !== undefined && <Text dimColor>idx:{state.fileIndexSize}</Text>}
          <Text dimColor>/help</Text>
        </Box>
      </Box>
    </Box>
  )
}
