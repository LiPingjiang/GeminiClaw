import React, { type Ref } from 'react'
import Box from '../../ink/components/Box.js'
import type { DOMElement } from '../../ink/dom.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import type { FocusEvent } from '../../ink/events/focus-event.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import type { Color, Styles } from '../../ink/styles.js'
import { getTheme as getThemeColors, type Theme } from '../../utils/theme.js'
import { useTheme } from './ThemeProvider.js'

// Color props that accept theme keys or bare ANSI names
type ThemedColorProps = {
  readonly borderColor?: keyof Theme | Color | string
  readonly borderTopColor?: keyof Theme | Color | string
  readonly borderBottomColor?: keyof Theme | Color | string
  readonly borderLeftColor?: keyof Theme | Color | string
  readonly borderRightColor?: keyof Theme | Color | string
  readonly backgroundColor?: keyof Theme | Color | string
}

// Base Styles without color props (they'll be overridden)
type BaseStylesWithoutColors = Omit<
  Styles,
  | 'textWrap'
  | 'borderColor'
  | 'borderTopColor'
  | 'borderBottomColor'
  | 'borderLeftColor'
  | 'borderRightColor'
  | 'backgroundColor'
>

export type Props = BaseStylesWithoutColors &
  ThemedColorProps & {
    ref?: Ref<DOMElement>
    tabIndex?: number
    autoFocus?: boolean
    onClick?: (event: ClickEvent) => void
    onFocus?: (event: FocusEvent) => void
    onFocusCapture?: (event: FocusEvent) => void
    onBlur?: (event: FocusEvent) => void
    onBlurCapture?: (event: FocusEvent) => void
    onKeyDown?: (event: KeyboardEvent) => void
    onKeyDownCapture?: (event: KeyboardEvent) => void
    onMouseEnter?: () => void
    onMouseLeave?: () => void
    children?: React.ReactNode
  }

const BARE_ANSI_NAMES = new Set([
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'blackBright', 'redBright', 'greenBright', 'yellowBright', 'blueBright',
  'magentaBright', 'cyanBright', 'whiteBright', 'gray', 'grey',
])

function resolveColor(
  color: string | undefined,
  theme: Theme,
): Color | undefined {
  if (!color) return undefined
  if (
    color.startsWith('rgb(') ||
    color.startsWith('#') ||
    color.startsWith('ansi256(') ||
    color.startsWith('ansi:')
  ) {
    return color as Color
  }
  // Theme key lookup
  if (color in theme) {
    return theme[color as keyof Theme] as Color
  }
  // Bare ANSI color name — prefix with ansi:
  if (BARE_ANSI_NAMES.has(color)) {
    return `ansi:${color}` as Color
  }
  return color as Color
}

/**
 * Theme-aware Box component that resolves theme color keys to raw colors.
 */
function ThemedBox({
  borderColor,
  borderTopColor,
  borderBottomColor,
  borderLeftColor,
  borderRightColor,
  backgroundColor,
  children,
  ref,
  ...rest
}: Props) {
  const [themeName] = useTheme()
  const theme = getThemeColors(themeName)

  return (
    <Box
      {...rest}
      ref={ref}
      borderColor={resolveColor(borderColor as string, theme)}
      borderTopColor={resolveColor(borderTopColor as string, theme)}
      borderBottomColor={resolveColor(borderBottomColor as string, theme)}
      borderLeftColor={resolveColor(borderLeftColor as string, theme)}
      borderRightColor={resolveColor(borderRightColor as string, theme)}
      backgroundColor={resolveColor(backgroundColor as string, theme)}
    >
      {children}
    </Box>
  )
}

export default ThemedBox
