import { describe, it, expect } from 'vitest'
import { parseOsascriptOutput, IMAGE_MAX_BYTES, detectMediaType } from './clipboard.js'

describe('parseOsascriptOutput', () => {
  it('parses hex from osascript output', () => {
    const input = '«data PNGF89504e47»'
    const result = parseOsascriptOutput(input)
    expect(result).not.toBeNull()
    // 89504e47 = PNG magic bytes in hex
    expect(result?.toString('hex')).toBe('89504e47')
  })

  it('returns null for non-PNG output', () => {
    expect(parseOsascriptOutput('missing value')).toBeNull()
    expect(parseOsascriptOutput('')).toBeNull()
    expect(parseOsascriptOutput('error: clipboard empty')).toBeNull()
  })
})

describe('detectMediaType', () => {
  it('detects PNG from extension', () => {
    expect(detectMediaType('/tmp/screenshot.png')).toBe('image/png')
  })
  it('detects JPEG', () => {
    expect(detectMediaType('photo.jpg')).toBe('image/jpeg')
    expect(detectMediaType('photo.jpeg')).toBe('image/jpeg')
  })
  it('detects GIF', () => {
    expect(detectMediaType('anim.gif')).toBe('image/gif')
  })
  it('detects WebP', () => {
    expect(detectMediaType('img.webp')).toBe('image/webp')
  })
  it('defaults to PNG for unknown', () => {
    expect(detectMediaType('unknown')).toBe('image/png')
  })
})

describe('IMAGE_MAX_BYTES', () => {
  it('is 5MB', () => {
    expect(IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024)
  })
})
