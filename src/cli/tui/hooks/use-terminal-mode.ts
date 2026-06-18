// src/cli/tui/hooks/use-terminal-mode.ts
import { useEffect } from 'react'
import { useStdout } from 'ink'

const MOUSE_ON  = '\x1b[?1000h\x1b[?1006h'  // enable VT200 + SGR mouse
const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l'  // disable

/**
 * Enable SGR mouse tracking on mount, restore on unmount.
 * Mouse wheel events will arrive as raw stdin bytes:
 *   \x1b[<64;X;YM  = wheel up
 *   \x1b[<65;X;YM  = wheel down
 */
export function useTerminalMode(): void {
  const { stdout } = useStdout()

  useEffect(() => {
    if (!stdout?.isTTY) return
    stdout.write(MOUSE_ON)
    return () => {
      stdout.write(MOUSE_OFF)
    }
  }, [stdout])
}
