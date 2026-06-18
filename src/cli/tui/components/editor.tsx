import React from 'react'
import { Box, Text, usePaste } from 'ink'
import { useTextInput } from '../hooks/use-text-input.js'
import { snapPos } from '../lib/grapheme.js'
import type { TuiAction } from '../state.js'

export interface EditorProps {
  value: string
  cursor: number
  columns: number
  focus: boolean
  dispatch: React.Dispatch<TuiAction>
  onSubmit: (message: string) => void
  onCancel: () => void
  onExit: () => void
}

const PROMPT = '> '
const PROMPT_WIDTH = 2 // '> ' is 2 columns wide

export function Editor({ value, cursor, columns, focus, dispatch, onSubmit, onCancel, onExit }: EditorProps) {
  // Bracketed paste: Ink 7 usePaste handles \x1b[200~...\x1b[201~ natively.
  // Pasted text is inserted at cursor position as a single string.
  usePaste(
    (text) => {
      if (!focus) return
      const newVal = value.slice(0, cursor) + text + value.slice(cursor)
      const newCur = snapPos(newVal, cursor + text.length)
      dispatch({ type: 'INPUT_CHANGE', value: newVal, cursor: newCur })
    },
    { isActive: focus },
  )

  const inputCols = Math.max(1, columns - PROMPT_WIDTH)

  const { rendered } = useTextInput({
    value,
    cursor,
    columns: inputCols,
    focus,
    onChange: (newVal, newCur) => dispatch({ type: 'INPUT_CHANGE', value: newVal, cursor: newCur }),
    onSubmit,
    onHistoryUp: () => dispatch({ type: 'INPUT_HISTORY_UP' }),
    onHistoryDown: () => dispatch({ type: 'INPUT_HISTORY_DOWN' }),
    onCancel,
    onExit,
  })

  if (!focus) {
    return (
      <Box>
        <Text color="gray" bold>{PROMPT}</Text>
        <Text dimColor>{value || 'waiting for agent...'}</Text>
      </Box>
    )
  }

  return (
    <Box>
      <Text color="yellow" bold>{PROMPT}</Text>
      {/* rendered contains ANSI escape sequences for cursor highlight */}
      <Text>{rendered}</Text>
    </Box>
  )
}
