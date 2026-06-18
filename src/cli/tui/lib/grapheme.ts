let _seg: Intl.Segmenter | null = null
const seg = (): Intl.Segmenter => (_seg ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' }))

// LRU cache — avoids re-segmenting the same string on every keystroke
const CACHE_MAX = 64
const stopCache = new Map<string, number[]>()

/**
 * Returns sorted array of JS string character index offsets at each grapheme
 * cluster boundary, including 0 (start) and s.length (end).
 * e.g. 'a你b' → [0, 1, 2, 3]  (UTF-16 code unit positions)
 */
export function graphemeStops(s: string): number[] {
  if (s.length === 0) return [0]
  const cached = stopCache.get(s)
  if (cached) return cached

  const stops: number[] = [0]
  for (const { index } of seg().segment(s)) {
    if (index > 0) stops.push(index)
  }
  if (stops[stops.length - 1] !== s.length) stops.push(s.length)

  stopCache.set(s, stops)
  if (stopCache.size > CACHE_MAX) {
    const oldest = stopCache.keys().next().value
    if (oldest !== undefined) stopCache.delete(oldest)
  }
  return stops
}

/** Snap p to the nearest grapheme boundary ≤ p */
export function snapPos(s: string, p: number): number {
  const pos = Math.max(0, Math.min(p, s.length))
  let last = 0
  for (const stop of graphemeStops(s)) {
    if (stop > pos) break
    last = stop
  }
  return last
}

/** Move cursor one grapheme cluster left. Returns 0 if already at start. */
export function prevPos(s: string, p: number): number {
  const pos = snapPos(s, p)
  let prev = 0
  for (const stop of graphemeStops(s)) {
    if (stop >= pos) return prev
    prev = stop
  }
  return prev
}

/** Move cursor one grapheme cluster right. Returns s.length if already at end. */
export function nextPos(s: string, p: number): number {
  const pos = snapPos(s, p)
  for (const stop of graphemeStops(s)) {
    if (stop > pos) return stop
  }
  return s.length
}

/** Jump left past trailing whitespace then past a word. */
export function wordLeft(s: string, p: number): number {
  let i = snapPos(s, p) - 1
  while (i > 0 && /\s/.test(s[i]!)) i--
  while (i > 0 && !/\s/.test(s[i - 1]!)) i--
  return Math.max(0, i)
}

/** Jump right past current word then trailing whitespace. */
export function wordRight(s: string, p: number): number {
  let i = snapPos(s, p)
  while (i < s.length && !/\s/.test(s[i]!)) i++
  while (i < s.length && /\s/.test(s[i]!)) i++
  return i
}

/**
 * Move cursor one logical line up (dir=-1) or down (dir=1) preserving column.
 * Returns null when already on the first (up) or last (down) line — signals
 * caller to fall through to history navigation.
 */
export function lineNav(s: string, p: number, dir: -1 | 1): number | null {
  const pos = snapPos(s, p)
  const curStart = s.lastIndexOf('\n', pos - 1) + 1
  const col = pos - curStart

  if (dir < 0) {
    if (curStart === 0) return null
    const prevStart = s.lastIndexOf('\n', curStart - 2) + 1
    return snapPos(s, Math.min(prevStart + col, curStart - 1))
  }

  const nextBreak = s.indexOf('\n', pos)
  if (nextBreak < 0) return null
  const nextEnd = s.indexOf('\n', nextBreak + 1)
  const lineEnd = nextEnd < 0 ? s.length : nextEnd
  return snapPos(s, Math.min(nextBreak + 1 + col, lineEnd))
}

/** Delete the grapheme cluster immediately before p. Returns [newString, newCursor]. */
export function deleteGraphemeBefore(s: string, p: number): [string, number] {
  if (p <= 0) return [s, 0]
  const prev = prevPos(s, p)
  return [s.slice(0, prev) + s.slice(p), prev]
}

/** Delete the grapheme cluster immediately at/after p. Returns [newString, newCursor]. */
export function deleteGraphemeAfter(s: string, p: number): [string, number] {
  if (p >= s.length) return [s, p]
  const next = nextPos(s, p)
  return [s.slice(0, p) + s.slice(next), p]
}
