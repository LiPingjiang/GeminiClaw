// Grapheme segmenter — use built-in Intl.Segmenter (Node 16+)
let segmenter: Intl.Segmenter | null = null

export function getGraphemeSegmenter(): Intl.Segmenter {
  if (!segmenter) {
    segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  }
  return segmenter
}
