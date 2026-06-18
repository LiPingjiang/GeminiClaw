import { describe, it, expect } from 'vitest'
import { renderWithCursor, computeCursorPosition } from './use-text-input.js'

describe('renderWithCursor', () => {
  it('inverts the character at cursor position', () => {
    const result = renderWithCursor('hello', 1)
    // character at offset 1 ('e') should be ANSI-inverted
    expect(result).toContain('\x1b[7m')   // invert on
    expect(result).toContain('\x1b[27m')  // invert off
    expect(result).toContain('e')
  })

  it('shows inverted space at end of string', () => {
    const result = renderWithCursor('hi', 2)
    expect(result).toContain('\x1b[7m \x1b[27m')
  })

  it('CJK character at cursor is inverted', () => {
    const result = renderWithCursor('你好', 0)
    expect(result).toContain('\x1b[7m你\x1b[27m')
  })

  it('emoji cluster at cursor is inverted as a unit', () => {
    const s = '👩‍💻'
    const result = renderWithCursor(s, 0)
    expect(result).toContain('\x1b[7m')
    expect(result).toContain(s)
  })

  it('cursor on newline shows inverted space then newline', () => {
    const result = renderWithCursor('a\nb', 1)
    // cursor on '\n' shows inverted space, then the newline still appears
    expect(result).toContain('\x1b[7m \x1b[27m')
    expect(result).toContain('\n')
    expect(result).toContain('a')
    expect(result).toContain('b')
  })
})

describe('computeCursorPosition', () => {
  it('cursor at start of single line', () => {
    const pos = computeCursorPosition('hello', 0, 80)
    expect(pos).toEqual({ row: 0, col: 0 })
  })

  it('cursor after first char', () => {
    const pos = computeCursorPosition('hello', 1, 80)
    expect(pos).toEqual({ row: 0, col: 1 })
  })

  it('CJK double-width shifts column by 2', () => {
    // '你' is a double-width character, takes 2 terminal columns
    // In JS, '你' has length 1, so cursor at position 1 is after '你'
    const pos = computeCursorPosition('你好', 1, 80)
    expect(pos).toEqual({ row: 0, col: 2 })
  })

  it('cursor wraps to next row when line is full', () => {
    // 10 chars, terminal 5 wide: cursor at position 5 is row 1, col 0
    const pos = computeCursorPosition('abcdeABCDE', 5, 5)
    expect(pos).toEqual({ row: 1, col: 0 })
  })
})
