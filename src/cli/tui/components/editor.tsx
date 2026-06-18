import React from 'react'
import { Box, Text, usePaste } from 'ink'
import { useTextInput } from '../hooks/use-text-input.js'
import { snapPos } from '../lib/grapheme.js'
import { readClipboardImage, readImageFile } from '../clipboard.js'
import type { TuiAction, InputAttachment } from '../state.js'

export interface EditorProps {
  value: string
  cursor: number
  columns: number
  focus: boolean
  dispatch: React.Dispatch<TuiAction>
  onSubmit: (message: string) => void
  onCancel: () => void
  onExit: () => void
  attachments: InputAttachment[]
  onScrollUp: () => void
  onScrollDown: () => void
  onScrollToBottom: () => void
  isRunning: boolean
  currentTool?: string
}

const PROMPT = '> '
const PROMPT_WIDTH = 2 // '> ' is 2 columns wide

export function Editor({ value, cursor, columns, focus, dispatch, onSubmit, onCancel, onExit, attachments, onScrollUp, onScrollDown, onScrollToBottom, isRunning, currentTool }: EditorProps) {
  // Bracketed paste: Ink 7 usePaste handles \x1b[200~...\x1b[201~ natively.
  // Pasted text is inserted at cursor position as a single string.
  usePaste(
    (text) => {
      if (!focus) return

      // Case A: image file path (.png/.jpg/.gif/.webp)
      if (/\.(png|jpe?g|gif|webp)$/i.test(text.trim())) {
        const img = readImageFile(text.trim())
        if (img) {
          const attachment: InputAttachment = {
            base64: img.base64,
            mediaType: img.mediaType,
            filename: img.filename,
            sizeBytes: img.sizeBytes,
          }
          dispatch({ type: 'INPUT_ATTACH_IMAGE', attachment })
          return
        }
      }

      // Case B: empty paste on macOS → clipboard image
      if (text.length === 0 && process.platform === 'darwin') {
        const img = readClipboardImage()
        if (img) {
          const attachment: InputAttachment = {
            base64: img.base64,
            mediaType: img.mediaType as InputAttachment['mediaType'],
            filename: 'clipboard',
            sizeBytes: Math.round(img.base64.length * 0.75),  // rough byte count
          }
          dispatch({ type: 'INPUT_ATTACH_IMAGE', attachment })
          return
        }
      }

      // Case C: normal text
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
    onEscape: () => {
      if (value === '' && attachments.length > 0) {
        dispatch({ type: 'INPUT_CLEAR_ATTACHMENTS' })
      }
    },
    onScrollUp,
    onScrollDown,
    onScrollToBottom,
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
    <Box flexDirection="column">
      {attachments.length > 0 && (
        <Box>
          {attachments.map((a, i) => (
            <Text key={i} dimColor>{' [🖼 '}{a.filename}{' '}{formatBytes(a.sizeBytes)}{']'}</Text>
          ))}
          <Text dimColor>{'  · Esc to clear'}</Text>
        </Box>
      )}
      <Box>
        <Text color="yellow" bold>{PROMPT}</Text>
        {/* rendered contains ANSI escape sequences for cursor highlight */}
        <Text>{rendered}</Text>
      </Box>
      <StatusBar
        focus={focus}
        isRunning={isRunning}
        currentTool={currentTool}
        inputEmpty={value === ''}
        inputIsCommand={value.startsWith('/')}
        columns={columns}
      />
    </Box>
  )
}

function StatusBar({
  focus,
  isRunning,
  currentTool,
  inputEmpty,
  inputIsCommand,
  columns,
}: {
  focus: boolean
  isRunning: boolean
  currentTool?: string
  inputEmpty: boolean
  inputIsCommand: boolean
  columns: number
}) {
  if (!focus) return null

  if (isRunning) {
    const toolLabel = currentTool ? `⚡${currentTool}` : 'Thinking…'
    return (
      <Box justifyContent="space-between">
        <Text dimColor>{'  ● '}{toolLabel}</Text>
        <Text dimColor>{'Ctrl+C interrupt  '}</Text>
      </Box>
    )
  }

  if (inputIsCommand) {
    return (
      <Box>
        <Text dimColor>{'  ↑↓ select  Tab complete  Esc close'}</Text>
      </Box>
    )
  }

  if (!inputEmpty) {
    return (
      <Box justifyContent="flex-end">
        <Text dimColor>{'Enter send  Shift+Enter newline  '}</Text>
      </Box>
    )
  }

  // idle + empty
  return (
    <Box justifyContent="space-between">
      <Text dimColor>{'  /btw · /clear · /model · /help'}</Text>
      <Text dimColor>{'? for commands  '}</Text>
    </Box>
  )
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${n}B`
}
