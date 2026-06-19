// src/cli/tui/gc-renderer/index.ts
import { appendFileSync } from 'fs'
import React from 'react'

function dbg(msg: string): void {
  try { appendFileSync('/tmp/gc-debug.log', msg + '\n') } catch {}
}
import { reconciler, ConcurrentRoot, setContainerScreen } from './reconciler.js'
import { ScreenBuffer } from './screen.js'
import { TerminalController } from './terminal.js'
import type { GCNode, GCContainer } from './types.js'
import { _inputHandlers, _exitFn } from './components.js'
import type { KeyLike } from './components.js'
import type { KeyEvent, MouseEvent } from './terminal.js'

export { Box, Text, AnsiBlock, Separator, useInput, useApp, useStdout, useStdin, type KeyLike } from './components.js'
export { useAnimationFrame } from './frame.js'

export interface RenderResult {
  waitUntilExit(): Promise<void>
  cleanup(): void
  rerender(element: React.ReactElement): void
  unmount(): void
}

export function render(element: React.ReactElement): RenderResult {
  const cols = process.stdout.columns ?? 80
  const rows = process.stdout.rows ?? 24

  const screen = new ScreenBuffer(cols, rows)
  const terminal = new TerminalController()

  const root: GCNode = {
    nodeType: 'gc-root',
    props: {},
    children: [],
    parent: null,
    computedX: 0, computedY: 0,
    computedWidth: cols, computedHeight: rows,
    dirty: true,
  }

  const container: GCContainer = { root, cols, rows }
  setContainerScreen(container, screen)

  const fiberRoot = reconciler.createContainer(
    container,
    ConcurrentRoot,
    null,
    false,
    null,
    '',
    (err: unknown) => { process.stderr.write('[gc-renderer] uncaught: ' + String(err) + '\n') },
    (err: unknown) => { process.stderr.write('[gc-renderer] caught: ' + String(err) + '\n') },
    (err: unknown) => { process.stderr.write('[gc-renderer] recoverable: ' + String(err) + '\n') },
    () => {},
  )

  // Exit plumbing
  let resolveExit!: () => void
  const exitPromise = new Promise<void>(r => { resolveExit = r })

  const cleanup = (): void => {
    terminal.exitAltScreen()
    reconciler.updateContainer(null, fiberRoot, null, null)
    resolveExit?.()
  }

  _exitFn.current = cleanup

  // Convert KeyEvent → KeyLike for useInput handlers
  function dispatchKey(key: KeyEvent): void {
    const like: KeyLike = {
      ctrl:       key.ctrl,
      shift:      key.shift,
      meta:       key.meta,
      upArrow:    key.key === 'up',
      downArrow:  key.key === 'down',
      leftArrow:  key.key === 'left',
      rightArrow: key.key === 'right',
      return:     key.key === 'return',
      escape:     key.key === 'escape',
      tab:        key.key === 'tab',
      backspace:  key.key === 'backspace',
      delete:     key.key === 'delete',
      pageUp:     key.key === 'pageup',
      pageDown:   key.key === 'pagedown',
      home:       key.key === 'home',
      end:        key.key === 'end',
    }
    for (const handler of _inputHandlers.values()) {
      handler(key.input, like)
    }
  }

  // Convert mouse scroll → key-like events
  function dispatchMouse(evt: MouseEvent): void {
    if (evt.button !== 64 && evt.button !== 65) return
    const isUp = evt.button === 64
    const like: KeyLike = {
      ctrl: false, shift: false, meta: false,
      upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
      return: false, escape: false, tab: false, backspace: false,
      delete: false, pageUp: isUp, pageDown: !isUp, home: false, end: false,
      scrollUp: isUp, scrollDown: !isUp,
    }
    for (const handler of _inputHandlers.values()) {
      handler('', like)
    }
  }

  terminal.onInput(dispatchKey)
  terminal.onMouse(dispatchMouse)
  terminal.onResize((newCols, newRows) => {
    container.cols = newCols
    container.rows = newRows
    screen.resize(newCols, newRows)
    reconciler.updateContainer(element, fiberRoot, null, null)
  })

  // Enter alt screen
  terminal.enterAltScreen(true)
  dbg('[render] alt screen entered')

  // Force initial synchronous render so the screen is painted immediately.
  // react-reconciler@0.33 removed flushSync; the correct pattern is
  // updateContainerSync (schedules on SyncLane) + flushSyncWork (drains it).
  dbg('[render] about to updateContainerSync + flushSyncWork')
  try {
    reconciler.updateContainerSync(element, fiberRoot, null, null)
    reconciler.flushSyncWork()
    dbg('[render] initial render done')
  } catch (err) {
    dbg('[render] initial render ERROR: ' + String(err))
    process.stderr.write('[gc-renderer] initial render error: ' + String(err) + '\n')
  }

  const handleSignal = (): void => { cleanup(); process.exit(0) }
  process.once('SIGTERM', handleSignal)

  return {
    waitUntilExit: () => exitPromise,
    cleanup,
    unmount: cleanup,
    rerender(el: React.ReactElement): void {
      element = el
      reconciler.updateContainer(el, fiberRoot, null, null)
    },
  }
}
