import { describe, it, expect } from 'vitest'
import { padAnsiLine } from './screen.js'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'

describe('padAnsiLine', () => {
  it('preserves exact-width lines unchanged', () => {
    const line = 'hello'
    expect(padAnsiLine(line, 5)).toBe(line)
  })

  it('pads short lines with spaces to target width', () => {
    const result = padAnsiLine('hi', 6)
    expect(stringWidth(stripAnsi(result))).toBe(6)
    expect(stripAnsi(result)).toBe('hi    ')
  })

  it('truncates long plain lines to target width', () => {
    const result = padAnsiLine('hello world', 5)
    expect(stringWidth(stripAnsi(result))).toBe(5)
    expect(stripAnsi(result)).toContain('hello')
  })

  it('truncates ANSI-styled lines while preserving visible-width correctness', () => {
    // Bold red "hello world" truncated to 5 visible chars
    const styled = '\x1b[1m\x1b[31mhello world\x1b[0m'
    const result = padAnsiLine(styled, 5)
    // Visible width must be exactly 5
    expect(stringWidth(stripAnsi(result))).toBe(5)
    // Must end with ANSI reset (we close open codes)
    expect(result).toMatch(/\x1b\[0m$/)
    // Must NOT contain the characters after the cut point
    expect(stripAnsi(result)).not.toContain('world')
  })

  it('handles empty string → all spaces', () => {
    const result = padAnsiLine('', 4)
    expect(result).toBe('    ')
  })

  it('handles width 0 → empty string', () => {
    expect(padAnsiLine('hello', 0)).toBe('')
  })
})
