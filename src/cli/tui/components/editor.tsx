import React from 'react'
import { Box, Text, useCursor, usePaste } from 'ink'
import { useTextInput } from '../hooks/use-text-input.js'
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
  const { setCursorPosition } = useCursor()

  // Bracketed paste: Ink 7 usePaste handles \x1b[200~...\x1b[201~ natively.
  // Pasted text is inserted at cursor position as a single string.
  usePaste(
    (text) => {
      if (!focus) return
      const newVal = value.slice(0, cursor) + text + value.slice(cursor)
      const newCur = cursor + text.length
      dispatch({ type: 'INPUT_CHANGE', value: newVal, cursor: newCur })
    },
    { isActive: focus },
  )

  const inputCols = Math.max(1, columns - PROMPT_WIDTH)

  const { rendered, cursorRow, cursorCol } = useTextInput({
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

  // Park the native terminal cursor at the text insertion point.
  // Terminal emulators display IME candidate windows at the physical cursor
  // position — this makes the CJK composition popup appear inline with the input.
  // useCursor(Ink 7) translates (x, y) relative to the Ink output origin into
  // an ANSI cursor-position escape written after each frame.
  React.useLayoutEffect(() => {
    if (focus) {
      // x and y are 0-based from Ink output origin
      setCursorPosition({ x: PROMPT_WIDTH + cursorCol, y: cursorRow })
    } else {
      setCursorPosition(undefined)
    }
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
