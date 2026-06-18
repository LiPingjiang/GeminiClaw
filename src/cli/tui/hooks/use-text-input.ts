import { useInput } from 'ink'
import {
  prevPos, nextPos,
  wordLeft, wordRight, lineNav,
  deleteGraphemeBefore, deleteGraphemeAfter,
} from '../lib/grapheme.js'

const INV = '\x1b[7m'
const INV_OFF = '\x1b[27m'

/**
 * Measure the display width of a single code point.
 * CJK and full-width characters are 2 columns wide, others are 1.
 */
function charDisplayWidth(cp: number): number {
  // East Asian Wide / Full-width ranges (simplified but accurate for common cases)
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals, Kangxi, etc.
    (cp >= 0x3040 && cp <= 0x33ff) || // Hiragana, Katakana, CJK
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0x4e00 && cp <= 0xa4cf) || // CJK Unified Ideographs
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended
    (cp >= 0xac00 && cp <= 0xd7ff) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe1f) || // Vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Latin/Katakana
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth Signs
    (cp >= 0x1f004 && cp <= 0x1f0cf) || // Mahjong/Playing cards
    (cp >= 0x1f300 && cp <= 0x1f9ff) || // Emoji
    (cp >= 0x20000 && cp <= 0x2a6df) || // CJK Extension B
    (cp >= 0x2a700 && cp <= 0x2ceaf) || // CJK Extension C/D/E
    (cp >= 0x2ceb0 && cp <= 0x2ebef) || // CJK Extension F
    (cp >= 0x30000 && cp <= 0x3134f)    // CJK Extension G
  ) {
    return 2
  }
  // Zero-width: combining marks, ZWJ, variation selectors
  if (cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f)) {
    return 0
  }
  return 1
}

/**
 * Compute display width of a string segment (sum of column widths of each code point).
 */
function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    w += charDisplayWidth(ch.codePointAt(0) ?? 0)
  }
  return w
}

/**
 * Render `value` with the character at `cursor` ANSI-inverted (visible cursor).
 * Uses Intl.Segmenter so CJK and emoji clusters are inverted as a whole unit.
 */
export function renderWithCursor(value: string, cursor: number): string {
  const pos = Math.max(0, Math.min(cursor, value.length))
  let out = ''
  let done = false

  for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
    if (!done && index >= pos) {
      // At cursor: invert this grapheme (or a space if at end / before newline)
      const display = segment === '\n' ? ' ' : segment
      out += INV + display + INV_OFF
      done = true
      if (segment !== '\n') continue
    }
    out += segment
  }

  // Cursor past end of string
  if (!done) out += INV + ' ' + INV_OFF

  return out
}

/**
 * Compute 0-based (row, col) cursor position within the input area.
 * Wraps at `columns` columns, accounting for double-width CJK characters.
 */
export function computeCursorPosition(
  value: string,
  cursor: number,
  columns: number,
): { row: number; col: number } {
  const pos = Math.max(0, Math.min(cursor, value.length))
  const cols = Math.max(1, columns)
  let row = 0
  let col = 0

  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  for (const { segment, index } of seg.segment(value)) {
    if (index >= pos) break
    if (segment === '\n') {
      row++
      col = 0
      continue
    }
    const w = displayWidth(segment)
    if (col + w > cols) {
      row++
      col = w
    } else {
      col += w
      // If we've exactly filled the line, wrap for next character
      if (col === cols) {
        row++
        col = 0
      }
    }
  }

  return { row, col }
}

export interface UseTextInputOpts {
  value: string
  cursor: number
  columns: number
  focus: boolean
  onChange: (value: string, cursor: number) => void
  onSubmit: (value: string) => void
  onHistoryUp: () => void
  onHistoryDown: () => void
  onCancel: () => void
  onExit: () => void
}

export interface UseTextInputResult {
  rendered: string
  cursorRow: number
  cursorCol: number
}

export function useTextInput(opts: UseTextInputOpts): UseTextInputResult {
  const { value, cursor, columns, focus, onChange, onSubmit } = opts

  useInput(
    (input, key) => {
      // ── Exit / interrupt ──────────────────────────────────────────
      if (key.ctrl && input === 'c') { opts.onCancel(); return }
      if (key.ctrl && input === 'd' && value === '') { opts.onExit(); return }

      // ── Submit ────────────────────────────────────────────────────
      if (key.return && !key.shift && !key.meta) {
        const msg = value.trim()
        if (msg) onSubmit(msg)
        return
      }

      // ── Shift/Meta+Enter — insert newline ─────────────────────────
      if (key.return && (key.shift || key.meta)) {
        const newVal = value.slice(0, cursor) + '\n' + value.slice(cursor)
        onChange(newVal, cursor + 1)
        return
      }

      // ── History navigation (up/down when on single/boundary line) ─
      if (key.upArrow && !key.shift) {
        const moved = lineNav(value, cursor, -1)
        if (moved === null) { opts.onHistoryUp(); return }
        onChange(value, moved)
        return
      }
      if (key.downArrow && !key.shift) {
        const moved = lineNav(value, cursor, 1)
        if (moved === null) { opts.onHistoryDown(); return }
        onChange(value, moved)
        return
      }

      // ── Cursor movement ───────────────────────────────────────────
      if (key.leftArrow && !key.ctrl && !key.meta) {
        onChange(value, prevPos(value, cursor)); return
      }
      if (key.rightArrow && !key.ctrl && !key.meta) {
        onChange(value, nextPos(value, cursor)); return
      }
      // Ctrl/Meta+Arrow — word jump
      if (key.leftArrow && (key.ctrl || key.meta)) {
        onChange(value, wordLeft(value, cursor)); return
      }
      if (key.rightArrow && (key.ctrl || key.meta)) {
        onChange(value, wordRight(value, cursor)); return
      }
      // Home / End / Ctrl+A / Ctrl+E
      if (key.home || (key.ctrl && input === 'a')) {
        const lineStart = value.lastIndexOf('\n', cursor - 1) + 1
        onChange(value, lineStart); return
      }
      if (key.end || (key.ctrl && input === 'e')) {
        const lineEnd = value.indexOf('\n', cursor)
        onChange(value, lineEnd < 0 ? value.length : lineEnd); return
      }

      // ── Deletion ──────────────────────────────────────────────────
      if (key.backspace) {
        const [newVal, newCur] = deleteGraphemeBefore(value, cursor)
        onChange(newVal, newCur); return
      }
      if (key.delete) {
        const [newVal, newCur] = deleteGraphemeAfter(value, cursor)
        onChange(newVal, newCur); return
      }
      // Ctrl+W — delete word before cursor
      if (key.ctrl && input === 'w') {
        const newCur = wordLeft(value, cursor)
        onChange(value.slice(0, newCur) + value.slice(cursor), newCur); return
      }
      // Ctrl+K — kill to end of line
      if (key.ctrl && input === 'k') {
        const lineEnd = value.indexOf('\n', cursor)
        onChange(value.slice(0, cursor) + (lineEnd >= 0 ? value.slice(lineEnd) : ''), cursor); return
      }
      // Ctrl+U — kill to start of line
      if (key.ctrl && input === 'u') {
        const lineStart = value.lastIndexOf('\n', cursor - 1) + 1
        onChange(value.slice(0, lineStart) + value.slice(cursor), lineStart); return
      }

      // ── Normal character input (including CJK, emoji) ─────────────
      if (input && !key.ctrl && !key.meta && !key.escape) {
        const newVal = value.slice(0, cursor) + input + value.slice(cursor)
        const newCur = cursor + input.length
        onChange(newVal, newCur)
      }
    },
    { isActive: focus },
  )

  const rendered = renderWithCursor(value, cursor)
  // Subtract 3 columns for the '> ' prompt prefix (2 chars + 1 space)
  const inputCols = Math.max(1, columns - 3)
  const { row, col } = computeCursorPosition(value, cursor, inputCols)

  return { rendered, cursorRow: row, cursorCol: col }
}
