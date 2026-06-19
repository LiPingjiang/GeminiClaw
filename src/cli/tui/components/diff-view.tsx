// src/cli/tui/components/diff-view.tsx
import React, { useState } from 'react'
import { Box, Text } from '../../../ink.js'
import { createTwoFilesPatch } from 'diff'

export type DiffLineType = 'add' | 'remove' | 'context' | 'hunk' | 'header'

export interface ParsedLine {
  type: DiffLineType
  content?: string   // for add/remove/context
  raw?: string       // for hunk/header
}

/**
 * Parse a unified diff string into typed line objects.
 * Accepts either a full diff string (multiple lines) or a single line.
 */
export function parseDiffLines(text: string): ParsedLine[] {
  const lines = text.split('\n')
  return lines.map((line): ParsedLine => {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) return { type: 'header', raw: line }
    if (line.startsWith('@@')) return { type: 'hunk', raw: line }
    if (line.startsWith('+')) return { type: 'add', content: line.slice(1) }
    if (line.startsWith('-')) return { type: 'remove', content: line.slice(1) }
    return { type: 'context', content: line.startsWith(' ') ? line.slice(1) : line }
  })
}

interface DiffViewProps {
  filename: string
  before: string
  after: string
  columns?: number
}

const MAX_UNCOLLAPSED_LINES = 40

export function DiffView({ filename, before, after, columns = 80 }: DiffViewProps) {
  const patch = createTwoFilesPatch(
    `a/${filename}`, `b/${filename}`,
    before, after,
    '', '', { context: 3 }
  )
  const lines = parseDiffLines(patch)

  // Count additions and deletions for summary
  const adds = lines.filter(l => l.type === 'add').length
  const dels = lines.filter(l => l.type === 'remove').length

  const [collapsed, setCollapsed] = useState(lines.length > MAX_UNCOLLAPSED_LINES)

  if (collapsed) {
    return (
      <Box>
        <Text dimColor>{'  '}{filename}</Text>
        <Text color="green">{`  +${adds}`}</Text>
        <Text color="red">{` −${dels}`}</Text>
        <Text dimColor>{'  [scroll to expand]'}</Text>
      </Box>
    )
  }

  const maxLineLen = Math.max(1, columns - 4)

  return (
    <Box flexDirection="column">
      <Text dimColor>{filename}</Text>
      {lines.map((line, i) => {
        if (line.type === 'header') return <Text key={i} dimColor>{truncate(line.raw ?? '', maxLineLen)}</Text>
        if (line.type === 'hunk')   return <Text key={i} color="yellow" dimColor>{truncate(line.raw ?? '', maxLineLen)}</Text>
        if (line.type === 'add') {
          const content = '+' + truncate(line.content ?? '', maxLineLen - 1)
          return (
            <Text key={i} backgroundColor="blue" color="white">
              {content.padEnd(maxLineLen)}
            </Text>
          )
        }
        if (line.type === 'remove') {
          const content = '-' + truncate(line.content ?? '', maxLineLen - 1)
          return (
            <Text key={i} backgroundColor="red" color="white">
              {content.padEnd(maxLineLen)}
            </Text>
          )
        }
        return <Text key={i} dimColor>{'  '}{truncate(line.content ?? '', maxLineLen - 2)}</Text>
      })}
    </Box>
  )
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}
