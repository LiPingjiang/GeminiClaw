import React, { memo, useRef } from 'react'
import { Box, Text } from 'ink'
import { findStableBoundary } from '../lib/streaming-boundary.js'
import { markdownToAnsiLines } from '../lib/ansi-markdown.js'
import { AnsiBlock } from '../lib/markdown-render.js'

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

  return (
    <Box flexDirection="column" width={columns}>
      {stable && <StableBlock text={stable} columns={columns} />}
      {unstable && (
        <Box width={columns}>
          <Text wrap="wrap">{unstable}</Text>
        </Box>
      )}
    </Box>
  )
})

const StableBlock = memo(function StableBlock({ text, columns }: { text: string; columns: number }) {
  const lines = markdownToAnsiLines(text, columns)
  return <AnsiBlock lines={lines} columns={columns} />
})
