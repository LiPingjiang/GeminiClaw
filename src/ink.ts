// src/ink.ts — public API for our Claude Code Ink port
import React from 'react'
import { renderSync } from './ink/root.js'
export { RawAnsi as AnsiBlock } from './ink/components/RawAnsi.js'

// Core components
export { default as Box } from './ink/components/Box.js'
export { default as Text } from './ink/components/Text.js'
export { default as Newline } from './ink/components/Newline.js'
export { default as Spacer } from './ink/components/Spacer.js'

// Hooks
export { default as useInput } from './ink/hooks/use-input.js'
export { default as useApp } from './ink/hooks/use-app.js'
export { default as useStdin } from './ink/hooks/use-stdin.js'

// Utilities
export { default as measureElement } from './ink/measure-element.js'

// Sync render — matches the gc-renderer's synchronous API shape
export type RenderOptions = {
  stdout?: NodeJS.WriteStream
  stdin?: NodeJS.ReadStream
  stderr?: NodeJS.WriteStream
  exitOnCtrlC?: boolean
  patchConsole?: boolean
}

export function render(
  node: React.ReactElement,
  options?: RenderOptions,
): { waitUntilExit(): Promise<void>; unmount(): void; rerender(el: React.ReactElement): void; cleanup(): void } {
  return renderSync(node, options)
}

// useStdout — not in this ink fork; implement directly
export function useStdout(): { stdout: NodeJS.WriteStream } {
  return { stdout: process.stdout }
}

// setCursor — no-op in real Ink (cursor is managed by Ink itself)
export function setCursor(_col: number, _row: number, _visible: boolean): void {}

// useAnimationFrame — no-arg compat shim; triggers re-renders via a ticker
export function useAnimationFrame(): void {
  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    const id = setInterval(() => { setTick(t => t + 1) }, 50)
    return () => clearInterval(id)
  }, [])
}
