import { describe, it, expect } from 'vitest'
import { parseDiffLines, DiffLineType } from './diff-view.js'

describe('parseDiffLines', () => {
  it('classifies addition lines', () => {
    const lines = parseDiffLines('+hello')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toEqual({ type: 'add', content: 'hello' })
  })

  it('classifies deletion lines', () => {
    const lines = parseDiffLines('-goodbye')
    expect(lines[0]).toEqual({ type: 'remove', content: 'goodbye' })
  })

  it('classifies context lines', () => {
    const lines = parseDiffLines(' unchanged')
    expect(lines[0]).toEqual({ type: 'context', content: 'unchanged' })
  })

  it('classifies hunk header lines', () => {
    const lines = parseDiffLines('@@ -1,3 +1,4 @@')
    expect(lines[0]).toEqual({ type: 'hunk', raw: '@@ -1,3 +1,4 @@' })
  })

  it('classifies file header lines', () => {
    const lines = parseDiffLines('--- a/file.ts')
    expect(lines[0]).toEqual({ type: 'header', raw: '--- a/file.ts' })
  })

  it('handles multi-line diff text', () => {
    const text = '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n ctx'
    const lines = parseDiffLines(text)
    expect(lines).toHaveLength(6)
    expect(lines[0].type).toBe('header')
    expect(lines[1].type).toBe('header')
    expect(lines[2].type).toBe('hunk')
    expect(lines[3].type).toBe('remove')
    expect(lines[4].type).toBe('add')
    expect(lines[5].type).toBe('context')
  })
})
