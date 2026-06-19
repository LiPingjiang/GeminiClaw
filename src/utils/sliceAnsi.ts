import stripAnsi from 'strip-ansi'

/**
 * Slice a string containing ANSI escape codes by visible character position.
 * This is a simplified version that strips ANSI and slices the plain text.
 * For full fidelity, replace with the slice-ansi npm package.
 */
export default function sliceAnsi(str: string, from: number, to?: number): string {
  const plain = stripAnsi(str)
  return plain.slice(from, to)
}
