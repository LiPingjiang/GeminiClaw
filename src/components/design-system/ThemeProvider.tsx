import React, { createContext, useContext, useState } from 'react'
import type { ThemeName, ThemeSetting } from '../../utils/theme.js'

type ThemeContextValue = {
  themeSetting: ThemeSetting
  setThemeSetting: (setting: ThemeSetting) => void
  currentTheme: ThemeName
}

const DEFAULT_THEME: ThemeName = 'dark'

const ThemeContext = createContext<ThemeContextValue>({
  themeSetting: DEFAULT_THEME,
  setThemeSetting: () => {},
  currentTheme: DEFAULT_THEME,
})

type Props = {
  children: React.ReactNode
  initialState?: ThemeSetting
}

export function ThemeProvider({ children, initialState = DEFAULT_THEME }: Props) {
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>(initialState)
  const currentTheme: ThemeName =
    themeSetting === 'auto' ? DEFAULT_THEME : (themeSetting as ThemeName)
  return (
    <ThemeContext.Provider value={{ themeSetting, setThemeSetting, currentTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

/**
 * Returns [currentTheme, setThemeSetting] — same signature as Claude Code.
 */
export function useTheme(): [ThemeName, (setting: ThemeSetting) => void] {
  const { currentTheme, setThemeSetting } = useContext(ThemeContext)
  return [currentTheme, setThemeSetting]
}

/**
 * Returns the resolved theme name (never 'auto').
 */
export function getTheme(): ThemeName {
  return DEFAULT_THEME
}
