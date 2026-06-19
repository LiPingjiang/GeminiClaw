import React from 'react'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Ansi } from '../../ink/Ansi.js'
import ThemedText from './ThemedText.js'
import type { Theme } from '../../utils/theme.js'

type DividerProps = {
  /**
   * Width of the divider in characters.
   * Defaults to terminal width.
   */
  width?: number

  /**
   * Theme color for the divider.
   * If not provided, dimColor is used.
   */
  color?: keyof Theme

  /**
   * Character to use for the divider line.
   * @default '─'
   */
  char?: string

  /**
   * Padding to subtract from the width (e.g., for indentation).
   * @default 0
   */
  padding?: number

  /**
   * Title shown in the middle of the divider.
   * May contain ANSI codes (e.g., chalk-styled text).
   */
  title?: string
}

/**
 * A horizontal divider line.
 */
export function Divider({
  width,
  color,
  char = '─',
  padding = 0,
  title,
}: DividerProps): React.ReactNode {
  const { columns: terminalWidth } = useTerminalSize()
  const effectiveWidth = Math.max(0, (width ?? terminalWidth) - padding)

  if (title) {
    const titleWidth = stringWidth(title) + 2
    const sideWidth = Math.max(0, effectiveWidth - titleWidth)
    const leftWidth = Math.floor(sideWidth / 2)
    const rightWidth = sideWidth - leftWidth
    return (
      <ThemedText color={color} dimColor={!color}>
        {char.repeat(leftWidth)}{' '}
        <ThemedText dimColor>
          <Ansi>{title}</Ansi>
        </ThemedText>{' '}
        {char.repeat(rightWidth)}
      </ThemedText>
    )
  }

  return (
    <ThemedText color={color} dimColor={!color}>
      {char.repeat(effectiveWidth)}
    </ThemedText>
  )
}
