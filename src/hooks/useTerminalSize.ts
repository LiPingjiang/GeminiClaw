import { useContext } from 'react'
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js'

/**
 * Returns the current terminal size from the Ink context.
 * Falls back to process.stdout dimensions if outside an Ink tree.
 */
export function useTerminalSize(): { columns: number; rows: number } {
  const size = useContext(TerminalSizeContext)
  if (size) return size
  return {
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  }
}
