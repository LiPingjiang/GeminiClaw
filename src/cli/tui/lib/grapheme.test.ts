import { describe, it, expect } from 'vitest'
import {
  graphemeStops, snapPos, prevPos, nextPos,
  wordLeft, wordRight, lineNav,
  deleteGraphemeBefore, deleteGraphemeAfter,
} from './grapheme.js'

describe('graphemeStops', () => {
  it('ASCII: one stop per character plus end', () => {
    expect(graphemeStops('abc')).toEqual([0, 1, 2, 3])
  })
  it('CJK: each char is one grapheme cluster', () => {
    // In JS strings, CJK chars have .length === 1 (UTF-16 code units, not bytes)
    expect(graphemeStops('你好')).toEqual([0, 1, 2])
  })
  it('emoji grapheme cluster counted as one stop', () => {
    // 👩‍💻 is U+1F469 ZWJ U+1F4BB — 3 code points, 1 grapheme
    const s = '👩‍💻'
    const stops = graphemeStops(s)
    expect(stops.length).toBe(2) // [0, s.length]
    expect(stops[0]).toBe(0)
    expect(stops[1]).toBe(s.length)
  })
  it('empty string: stops are [0]', () => {
    expect(graphemeStops('')).toEqual([0])
  })
})

describe('prevPos / nextPos', () => {
  it('ASCII: steps by 1', () => {
    expect(prevPos('hello', 3)).toBe(2)
    expect(nextPos('hello', 3)).toBe(4)
  })
  it('CJK: steps by 1 JS char index (not bytes)', () => {
    // In JS strings, '你好' — '你' is index 0, '好' is index 1
    expect(prevPos('你好', 2)).toBe(1)
    expect(nextPos('你好', 0)).toBe(1)
  })
  it('prevPos at 0 stays at 0', () => {
    expect(prevPos('hello', 0)).toBe(0)
  })
  it('nextPos at end stays at end', () => {
    expect(nextPos('hello', 5)).toBe(5)
  })
  it('emoji cluster: prevPos jumps the whole cluster', () => {
    const s = 'a👩‍💻b'
    const end = s.length
    // 'b' is last char, go back past it
    const atB = end - 1
    // go back past emoji cluster
    expect(prevPos(s, atB)).toBe(1)
  })
})

describe('wordLeft / wordRight', () => {
  it('jumps over a word', () => {
    expect(wordLeft('hello world', 11)).toBe(6)
    expect(wordLeft('hello world', 6)).toBe(0)
  })
  it('wordRight skips word then spaces', () => {
    expect(wordRight('hello world', 0)).toBe(6)
    expect(wordRight('hello world', 6)).toBe(11)
  })
})

describe('lineNav', () => {
  it('returns null going up from first line', () => {
    expect(lineNav('hello', 3, -1)).toBeNull()
  })
  it('returns null going down from last line', () => {
    expect(lineNav('hello', 3, 1)).toBeNull()
  })
  it('moves up one line preserving column', () => {
    const s = 'hello\nworld'
    // cursor at 'o' of 'world' = offset 9 (col 3 from line start 6)
    const result = lineNav(s, 9, -1)
    // should land at col 3 of 'hello' = offset 3
    expect(result).toBe(3)
  })
  it('moves down one line preserving column', () => {
    const s = 'hello\nworld'
    const result = lineNav(s, 3, 1)
    // col 3 of 'world' = offset 6+3 = 9
    expect(result).toBe(9)
  })
})

describe('deleteGraphemeBefore', () => {
  it('ASCII backspace', () => {
    expect(deleteGraphemeBefore('hello', 5)).toEqual(['hell', 4])
  })
  it('CJK backspace', () => {
    // In JS strings, '你好' has length 2, '好' is at index 1
    expect(deleteGraphemeBefore('你好', 2)).toEqual(['你', 1])
  })
  it('emoji cluster backspace', () => {
    const s = 'a👩‍💻'
    expect(deleteGraphemeBefore(s, s.length)).toEqual(['a', 1])
  })
  it('at position 0 does nothing', () => {
    expect(deleteGraphemeBefore('hello', 0)).toEqual(['hello', 0])
  })
})

describe('deleteGraphemeAfter', () => {
  it('ASCII forward delete', () => {
    expect(deleteGraphemeAfter('hello', 0)).toEqual(['ello', 0])
  })
  it('CJK forward delete', () => {
    // In JS strings, '你好' — deleting '你' at index 0 leaves '好'
    expect(deleteGraphemeAfter('你好', 0)).toEqual(['好', 0])
  })
  it('at end does nothing', () => {
    expect(deleteGraphemeAfter('hello', 5)).toEqual(['hello', 5])
  })
})
