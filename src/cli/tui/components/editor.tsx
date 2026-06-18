// src/cli/tui/components/editor.tsx  — STUB, replaced in Task 6
import React from 'react'
import { Box, Text } from 'ink'

export interface EditorProps {
  value: string
  cursor: number
  columns: number
  focus: boolean
  dispatch: (action: { type: string; [k: string]: unknown }) => void
  onSubmit?: (message: string) => void
  onCancel?: () => void
  onExit?: () => void
}

export function Editor({ value, focus }: EditorProps) {
  return (
    <Box>
      <Text color={focus ? 'yellow' : 'gray'} bold>{'> '}</Text>
      <Text>{value}</Text>
    </Box>
  )
}
