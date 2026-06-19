// src/cli/tui/gc-renderer/components.tsx
import React, { useEffect, useRef } from 'react'

// ── JSX element factories (host types map to gc-* reconciler nodes) ────────────

interface BoxProps {
  flexDirection?: 'column' | 'row'
  width?: number | string
  height?: number
  flexGrow?: number
  flexShrink?: number
  gap?: number
  justifyContent?: 'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around' | string
  paddingLeft?: number
  paddingTop?: number
  paddingBottom?: number
  marginTop?: number
  marginBottom?: number
  overflowY?: 'hidden' | 'scroll'
  children?: React.ReactNode
  key?: React.Key
  ref?: React.Ref<unknown>
}

interface TextProps {
  bold?: boolean
  italic?: boolean
  dimColor?: boolean
  color?: string
  backgroundColor?: string
  underline?: boolean
  inverse?: boolean
  wrap?: 'wrap' | 'truncate' | 'end'
  paddingLeft?: number
  children?: React.ReactNode
  key?: React.Key
}

interface AnsiBlockProps {
  lines: string[]
  width: number
  key?: React.Key
}

interface SeparatorProps {
  dimColor?: boolean
  key?: React.Key
}

export function Box(props: BoxProps): React.ReactElement {
  const { children, ...rest } = props
  return React.createElement('gc-box', rest as Record<string, unknown>, children)
}

export function Text(props: TextProps): React.ReactElement {
  const { children, ...rest } = props
  return React.createElement('gc-text', rest as Record<string, unknown>, children)
}

export function AnsiBlock(props: AnsiBlockProps): React.ReactElement {
  return React.createElement('gc-ansi', props as unknown as Record<string, unknown>)
}

export function Separator(props: SeparatorProps = {}): React.ReactElement {
  return React.createElement('gc-separator', props as Record<string, unknown>)
}

// ── Input handling ────────────────────────────────────────────────────────────

// Registry lives here; index.ts accesses it via the exported ref
export const _inputHandlers = new Map<symbol, (input: string, key: KeyLike) => void>()

export interface KeyLike {
  ctrl: boolean
  shift: boolean
  meta: boolean
  upArrow: boolean
  downArrow: boolean
  leftArrow: boolean
  rightArrow: boolean
  return: boolean
  escape: boolean
  tab: boolean
  backspace: boolean
  delete: boolean
  pageUp: boolean
  pageDown: boolean
  home: boolean
  end: boolean
  [k: string]: boolean | undefined
}

export function useInput(
  handler: (input: string, key: KeyLike) => void,
  options?: { isActive?: boolean },
): void {
  const active = options?.isActive !== false
  const idRef = useRef<symbol>(Symbol())
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!active) {
      _inputHandlers.delete(idRef.current)
      return
    }
    const id = idRef.current
    _inputHandlers.set(id, (input, key) => handlerRef.current(input, key))
    return () => { _inputHandlers.delete(id) }
  }, [active])
}

// ── App / stdout / stdin hooks ────────────────────────────────────────────────

export const _exitFn = { current: null as (() => void) | null }

export function useApp(): { exit(): void } {
  return { exit() { _exitFn.current?.() } }
}

export function useStdout(): { stdout: NodeJS.WriteStream } {
  return { stdout: process.stdout }
}

export function useStdin(): { stdin: NodeJS.ReadStream; setRawMode(b: boolean): void } {
  return {
    stdin: process.stdin,
    setRawMode(b: boolean) {
      if (process.stdin.isTTY) process.stdin.setRawMode(b)
    },
  }
}
