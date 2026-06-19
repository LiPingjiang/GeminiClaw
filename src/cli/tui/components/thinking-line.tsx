// src/cli/tui/components/thinking-line.tsx
import React, { useEffect, useState } from 'react'
import { Box, Text } from '../../../ink.js'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

interface ThinkingLineProps {
  elapsedMs: number        // from TICK — elapsed ms since agent started
  thinkingStartMs: number  // when thinking_delta first arrived (epoch ms)
  isStreaming: boolean     // true while thinking_delta still coming in
}

export function ThinkingLine({ elapsedMs, thinkingStartMs, isStreaming }: ThinkingLineProps) {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!isStreaming) return
    const timer = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 100)
    return () => clearInterval(timer)
  }, [isStreaming])

  if (!isStreaming) return null

  const thinkingSeconds = thinkingStartMs > 0
    ? Math.floor((Date.now() - thinkingStartMs) / 1000)
    : Math.floor(elapsedMs / 1000)

  return (
    <Box marginTop={1}>
      <Text dimColor italic>
        {'∴ Thinking… ('}{thinkingSeconds}{'s) '}{SPINNER_FRAMES[frame]}
      </Text>
    </Box>
  )
}
