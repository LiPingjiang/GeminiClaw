/**
 * Count ``` / ~~~ fence toggles in `s` up to `end`.
 * Returns true if inside an open fence at position `end`.
 */
function fenceOpenAt(s: string, end: number): boolean {
  let codeOpen = false
  let i = 0

  while (i < end) {
    const nl = s.indexOf('\n', i)
    const lineEnd = nl < 0 || nl > end ? end : nl
    const line = s.slice(i, lineEnd).trim()

    if (/^(?:`{3,}|~{3,})/.test(line)) {
      codeOpen = !codeOpen
    }

    if (nl < 0 || nl >= end) break
    i = nl + 1
  }

  return codeOpen
}

/**
 * Find the last "\n\n" paragraph boundary in `text` that falls outside any
 * fenced code block. Returns the index immediately after the second newline
 * (start of the next paragraph), or -1 if no safe boundary exists.
 *
 * Used by StreamingMd to split in-flight text into a memoized stable prefix
 * and a re-parsed unstable suffix, reducing re-parse cost from O(total) to
 * O(suffix) per delta.
 */
export function findStableBoundary(text: string): number {
  let idx = text.length

  while (idx > 0) {
    const boundary = text.lastIndexOf('\n\n', idx - 1)
    if (boundary < 0) return -1

    const splitAt = boundary + 2
    if (!fenceOpenAt(text, splitAt)) return splitAt

    idx = boundary
  }

  return -1
}
