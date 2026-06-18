// src/cli/tui/components/suggestion-overlay.tsx
import React from 'react'
import { Box, Text } from 'ink'
import type { TuiCommand } from '../commands/registry.js'

interface SuggestionOverlayProps {
  suggestions: TuiCommand[]
  selectedSuggestion: number
  columns: number
}

export function SuggestionOverlay({ suggestions, selectedSuggestion, columns }: SuggestionOverlayProps) {
  if (suggestions.length === 0) return null

  return (
    <Box flexDirection="column" flexShrink={0}>
      {suggestions.map((cmd, i) => {
        const isSelected = i === selectedSuggestion
        const descMaxLen = Math.max(0, columns - cmd.prefix.length - (cmd.argHint?.length ?? 0) - 8)
        const desc = cmd.description.length > descMaxLen
          ? cmd.description.slice(0, descMaxLen - 1) + '…'
          : cmd.description
        return (
          <Box key={cmd.name}>
            <Text inverse={isSelected} color={isSelected ? undefined : 'white'} dimColor={!isSelected}>
              {isSelected ? '▶ ' : '  '}
              {cmd.prefix.padEnd(10)}
              {' '}
              {desc.padEnd(descMaxLen)}
              {cmd.argHint ? `  ${cmd.argHint}` : ''}
            </Text>
          </Box>
        )
      })}
      <Text dimColor>{'─'.repeat(Math.max(0, columns))}</Text>
    </Box>
  )
}
