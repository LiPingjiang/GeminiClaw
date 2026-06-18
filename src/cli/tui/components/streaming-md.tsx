import React, { memo, useRef } from 'react'
import { Box } from 'ink'
import { findStableBoundary } from '../lib/streaming-boundary.js'
import { renderMarkdown } from '../lib/markdown-render.js'

interface StreamingMdProps {
  text: string
  columns: number
}

export const StreamingMd = memo(function StreamingMd({ text, columns }: StreamingMdProps) {
  const stablePrefixRef = useRef('')

  if (!text.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = ''
  }

  const boundary = findStableBoundary(text)

  if (boundary > stablePrefixRef.current.length) {
    stablePrefixRef.current = text.slice(0, boundary)
  }

  const stable = stablePrefixRef.current
  const unstable = text.slice(stable.length)

  if (!stable) return <>{renderMarkdown(unstable, columns)}</>
  if (!unstable) return <StableBlock text={stable} columns={columns} />

  return (
    <Box flexDirection="column">
      <StableBlock text={stable} columns={columns} />
      {renderMarkdown(unstable, columns)}
    </Box>
  )
})

const StableBlock = memo(function StableBlock({ text, columns }: { text: string; columns: number }) {
  return <>{renderMarkdown(text, columns)}</>
})
