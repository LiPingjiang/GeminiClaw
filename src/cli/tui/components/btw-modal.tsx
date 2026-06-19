import React, { useEffect, useState } from 'react'
import { Box, Text } from '../../../ink.js'
import type { BtwPhase } from '../state.js'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const MAX_HEIGHT = 12

interface BtwModalProps {
  btwState: BtwPhase
  columns: number
}

export function BtwModal({ btwState, columns }: BtwModalProps) {
  const [frame, setFrame] = useState(0)
  const isLoading = btwState.phase === 'loading'

  useEffect(() => {
    if (!isLoading) return
    const timer = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 100)
    return () => clearInterval(timer)
  }, [isLoading])

  if (btwState.phase === 'idle') return null

  const border = '╌'.repeat(Math.max(0, columns))
  const question = btwState.question

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text dimColor>{border}</Text>
      <Text dimColor>{'  /btw  '}<Text>{question}</Text></Text>
      <Text dimColor>{border}</Text>
      {btwState.phase === 'loading' && (
        <Text dimColor italic>{'  ∴ Thinking… '}{SPINNER_FRAMES[frame]}</Text>
      )}
      {btwState.phase === 'showing' && (
        <>
          <Box height={Math.min(MAX_HEIGHT, btwState.content.split('\n').length)} overflowY="hidden">
            <Box flexDirection="column" marginTop={-btwState.scrollOffset}>
              {btwState.content.split('\n').map((line, i) => (
                <Text key={i}>{'  '}{line}</Text>
              ))}
            </Box>
          </Box>
          <Text dimColor>{'  ↑/↓ scroll  Esc close'}</Text>
        </>
      )}
      <Text dimColor>{border}</Text>
    </Box>
  )
}
