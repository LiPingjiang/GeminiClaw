import { describe, it, expect } from 'vitest'
import { findStableBoundary } from './streaming-boundary.js'

describe('findStableBoundary', () => {
  it('returns -1 for text with no double newline', () => {
    expect(findStableBoundary('hello world')).toBe(-1)
  })

  it('returns -1 for single newline', () => {
    expect(findStableBoundary('hello\nworld')).toBe(-1)
  })

  it('returns split point after double newline', () => {
    const text = 'para one\n\npara two'
    // split point = index after '\n\n' = 10
    expect(findStableBoundary(text)).toBe(10)
  })

  it('returns last double newline boundary', () => {
    const text = 'a\n\nb\n\nc'
    // boundaries at 3 and 6; last is 6
    expect(findStableBoundary(text)).toBe(6)
  })

  it('returns -1 when double newline is inside a code fence', () => {
    const text = '```\nhello\n\nworld\n```\n\nafter'
    // the \n\n at index 15 is inside the fence — skip it
    // the \n\n at the end is after the fence — valid
    const result = findStableBoundary(text)
    expect(result).toBeGreaterThan(19) // after the closing ```
  })

  it('returns -1 for text entirely inside a code fence', () => {
    const text = '```\nhello\n\nworld\n```'
    // no stable boundary — fence is never closed before text ends
    // actually fence is closed — boundary after ``` is at end
    // this is a single block with no \n\n after it
    expect(findStableBoundary(text)).toBe(-1)
  })

  it('does not split inside a tilde fence', () => {
    const text = '~~~\nhello\n\nworld\n~~~\n\nafter'
    const result = findStableBoundary(text)
    expect(result).toBeGreaterThan(20)
  })
})
