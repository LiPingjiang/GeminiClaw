import React, { memo, useRef } from 'react'
import { Box, Text } from 'ink'
import { findStableBoundary } from '../lib/streaming-boundary.js'

interface StreamingMdProps {
  text: string
  columns: number
}

/**
 * Incremental Markdown renderer for in-flight streaming text.
 *
 * Naive approach: re-parse the entire message on every delta.
 * At 20-char deltas over a 3KB response = 150 full re-parses.
 *
 * This approach:
 * - Finds the last stable paragraph boundary (\n\n outside code fences)
 * - stablePrefix: rendered once with React.memo, never re-parses
 * - unstableSuffix: only this tail re-renders on each delta
 *
 * The two parts are stacked in a column Box — they MUST be column-stacked
 * or they render side-by-side (Ink's default is row flex).
 */
export const StreamingMd = memo(function StreamingMd({ text, columns }: StreamingMdProps) {
  const stablePrefixRef = useRef('')

  // Reset if text no longer starts with our cached prefix (e.g. turn cleared)
  if (!text.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = ''
  }

  const boundary = findStableBoundary(text)

  // Only advance the prefix — never retreat. Monotonic growth keeps the
  // memo key stable: identical string → same subtree → no re-render.
  if (boundary > stablePrefixRef.current.length) {
    stablePrefixRef.current = text.slice(0, boundary)
  }

  const stable = stablePrefixRef.current
  const unstable = text.slice(stable.length)

  if (!stable) return <InlineText text={unstable} columns={columns} />
  if (!unstable) return <InlineText text={stable} columns={columns} />

  return (
    <Box flexDirection="column">
      <StableBlock text={stable} columns={columns} />
      <InlineText text={unstable} columns={columns} />
    </Box>
  )
})

// Memoized stable block — React.memo means it only re-renders when `text` changes.
// Since stablePrefix only grows, its memo key never changes mid-turn.
const StableBlock = memo(function StableBlock({ text, columns }: { text: string; columns: number }) {
  return <InlineText text={text} columns={columns} />
})

// Simple text renderer. In a future iteration this could be replaced with
// a markdown parser (marked + Ink-compatible renderer). For now, plain text
// with color="green" to match the current response style.
function InlineText({ text }: { text: string; columns: number }) {
  return (
    <Box marginLeft={2}>
      <Text color="green" wrap="wrap">{text}</Text>
    </Box>
  )
}
