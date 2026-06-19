import React, { type ReactNode, useContext } from 'react'
import Text from '../../ink/components/Text.js'
import type { Color, Styles } from '../../ink/styles.js'
import { getTheme as getThemeColors, type Theme } from '../../utils/theme.js'
import { useTheme } from './ThemeProvider.js'

/** Colors uncolored ThemedText in the subtree. Precedence: explicit `color` >
 *  this > dimColor. Crosses Box boundaries (Ink's style cascade doesn't). */
export const TextHoverColorContext = React.createContext<keyof Theme | undefined>(undefined)

export type Props = {
  readonly color?: keyof Theme | Color | string
  readonly backgroundColor?: keyof Theme | Color | string
  readonly dimColor?: boolean
  readonly bold?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly strikethrough?: boolean
  readonly inverse?: boolean
  readonly wrap?: Styles['textWrap']
  readonly children?: ReactNode
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
 * Theme-aware Text component that resolves theme color keys to raw colors.
 */
export default function ThemedText({
  color,
  backgroundColor,
  dimColor,
  bold,
  italic,
  underline,
  strikethrough,
  inverse,
  wrap,
  children,
}: Props) {
  const [themeName] = useTheme()
  const theme = getThemeColors(themeName)

  const hoverColor = useContext(TextHoverColorContext)

  // Resolve color: explicit color > hover context > dimColor
  const resolvedColor =
    color !== undefined
      ? resolveColor(color as string, theme)
      : hoverColor !== undefined
        ? resolveColor(hoverColor as string, theme)
        : undefined

  const resolvedDimColor =
    color === undefined && hoverColor === undefined ? dimColor : undefined

  const resolvedBg = backgroundColor
    ? resolveColor(backgroundColor as string, theme)
    : undefined

  return (
    <Text
      color={resolvedColor}
      backgroundColor={resolvedBg}
      dimColor={resolvedDimColor}
      bold={bold}
      italic={italic}
      underline={underline}
      strikethrough={strikethrough}
      inverse={inverse}
      wrap={wrap}
    >
      {children}
    </Text>
  )
}
