// src/ink.ts — GeminiClaw's Claude Code Ink port public API
// Mirrors Claude Code's src/ink.ts exactly.
import { createElement, type ReactNode } from 'react'
import { ThemeProvider } from './components/design-system/ThemeProvider.js'
import {
  renderSync as inkRender,
  createRoot as inkCreateRoot,
  type RenderOptions,
  type Instance,
  type Root,
} from './ink/root.js'

// Wrap all render calls with ThemeProvider so ThemedBox/ThemedText work
function withTheme(node: ReactNode): ReactNode {
  return createElement(ThemeProvider, null, node)
}

/** Mount a component and render the output. Returns after first render. */
export async function render(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Promise<Instance> {
  return inkRender(withTheme(node), options)
}

export async function createRoot(options?: RenderOptions): Promise<Root> {
  const root = await inkCreateRoot(options)
  return {
    ...root,
    render: (node: ReactNode) => root.render(withTheme(node)),
  }
}

export type { RenderOptions, Instance, Root }

// Core ink components
export { color } from './components/design-system/color.js'
export type { Props as BoxProps } from './components/design-system/ThemedBox.js'
export { default as Box } from './components/design-system/ThemedBox.js'
export type { Props as TextProps } from './components/design-system/ThemedText.js'
export { default as Text } from './components/design-system/ThemedText.js'
export { Ansi } from './ink/Ansi.js'
export type { Props as BaseBoxProps } from './ink/components/Box.js'
export { default as BaseBox } from './ink/components/Box.js'
export { default as Newline } from './ink/components/Newline.js'
export { NoSelect } from './ink/components/NoSelect.js'
export { RawAnsi } from './ink/components/RawAnsi.js'
export { default as Spacer } from './ink/components/Spacer.js'
export { AlternateScreen } from './ink/components/AlternateScreen.js'
export { default as ScrollBox } from './ink/components/ScrollBox.js'

// Hooks - all real implementations
export { default as useApp } from './ink/hooks/use-app.js'
export { default as useInput } from './ink/hooks/use-input.js'
export { default as useStdin } from './ink/hooks/use-stdin.js'
export { useAnimationFrame } from './ink/hooks/use-animation-frame.js'
export { default as measureElement } from './ink/measure-element.js'
export { stringWidth } from './ink/stringWidth.js'

// Theme system
export { ThemeProvider, useTheme, getTheme } from './components/design-system/ThemeProvider.js'

// useStdout — returns the current stdout from the Ink instance context
export function useStdout(): { stdout: NodeJS.WriteStream } {
  return { stdout: process.stdout }
}

// setCursor — no-op in real Ink (cursor is managed by Ink itself)
export function setCursor(_col: number, _row: number, _visible: boolean): void {}

// AnsiBlock = RawAnsi (our internal alias)
export { RawAnsi as AnsiBlock } from './ink/components/RawAnsi.js'

// Type stubs for Claude Code compatibility
export type ClickEvent = any
export type DOMElement = any
export type Key = any
