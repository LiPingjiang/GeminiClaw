// src/cli/tui/clipboard.ts
import { execSync, execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { basename } from 'path'

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024  // 5MB

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export function detectMediaType(path: string): ImageMediaType {
  const lower = path.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'image/png'
}

/**
 * Parse the hex output from `osascript -e 'the clipboard as «class PNGf»'`.
 * Returns a Buffer, or null if the clipboard does not contain PNG data.
 */
export function parseOsascriptOutput(raw: string): Buffer | null {
  const match = raw.trim().match(/«data PNGF([0-9a-fA-F]+)»/)
  if (!match || !match[1]) return null
  return Buffer.from(match[1], 'hex')
}

/**
 * Read a PNG image from the system clipboard.
 * macOS: uses osascript. Linux: uses xclip or wl-paste.
 * Returns null if clipboard has no image or on unsupported platforms.
 */
export function readClipboardImage(): { base64: string; mediaType: ImageMediaType } | null {
  try {
    if (process.platform === 'darwin') {
      const raw = execSync(`osascript -e 'the clipboard as «class PNGf»'`, {
        timeout: 3000, encoding: 'utf-8',
      })
      const buf = parseOsascriptOutput(raw)
      if (!buf || buf.length > IMAGE_MAX_BYTES) return null
      return { base64: buf.toString('base64'), mediaType: 'image/png' }
    }

    if (process.platform === 'linux') {
      // Try xclip first, then wl-paste (Wayland)
      let buf: Buffer | null = null
      try {
        buf = execFileSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], { timeout: 3000 })
      } catch {
        try {
          buf = execFileSync('wl-paste', ['--type', 'image/png'], { timeout: 3000 })
        } catch { return null }
      }
      if (!buf || buf.length === 0 || buf.length > IMAGE_MAX_BYTES) return null
      return { base64: buf.toString('base64'), mediaType: 'image/png' }
    }

    return null  // Windows not supported in V1
  } catch {
    return null
  }
}

/**
 * Read an image file from disk. Cleans up shell-escaped paths.
 * Returns null if file is missing, not an image, or exceeds 5MB.
 */
export function readImageFile(rawPath: string): { base64: string; mediaType: ImageMediaType; filename: string; sizeBytes: number } | null {
  const path = rawPath.trim().replace(/\\ /g, ' ').replace(/^['"]|['"]$/g, '')
  if (!/\.(png|jpe?g|gif|webp)$/i.test(path)) return null
  try {
    const buf = readFileSync(path)
    if (buf.length > IMAGE_MAX_BYTES) return null
    return {
      base64: buf.toString('base64'),
      mediaType: detectMediaType(path),
      filename: basename(path),
      sizeBytes: buf.length,
    }
  } catch { return null }
}
