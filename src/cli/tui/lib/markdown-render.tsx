import React, { memo } from 'react'
import { Box, Text } from '../gc-renderer/index.js'
import { markdownToAnsiLines } from './ansi-markdown.js'

interface AnsiBlockProps {
  lines: string[]
  columns: number
}

/**
 * Renders pre-wrapped ANSI lines as a column of Text components.
 * Since lines are already width-capped, Ink doesn't need to re-wrap.
 */
export const AnsiBlock = memo(function AnsiBlock({ lines, columns }: AnsiBlockProps) {
  if (lines.length === 0) return null
  return (
    <Box flexDirection="column" width={columns}>
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate">{line}</Text>
      ))}
    </Box>
  )
})

/**
 * Convert markdown to ANSI lines and render.
 * The single public function used by all message rendering code.
 */
export function renderMarkdown(text: string, columns: number): React.ReactNode {
  if (!text) return null
  const lines = markdownToAnsiLines(text, columns)
  return <AnsiBlock lines={lines} columns={columns} />
}
