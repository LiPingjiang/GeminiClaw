import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderMarkdown } from './markdown-render.js'

describe('renderMarkdown', () => {
  it('returns a ReactNode for plain text', () => {
    const node = renderMarkdown('hello world', 80)
    expect(node).not.toBeNull()
  })

  it('returns a ReactNode for markdown with headings', () => {
    const node = renderMarkdown('# Hello\n\nParagraph', 80)
    expect(node).not.toBeNull()
  })

  it('returns a ReactNode for code blocks', () => {
    const node = renderMarkdown('```js\nconsole.log(1)\n```', 80)
    expect(node).not.toBeNull()
  })

  it('handles empty string', () => {
    const node = renderMarkdown('', 80)
    expect(node).toBeNull()
  })
})
