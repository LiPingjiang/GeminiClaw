/**
 * Fuzzy Edit Module for GeminiClaw
 *
 * Implements an 8-strategy matching chain to robustly find and replace text,
 * accommodating variations in whitespace, indentation, curly quotes, and
 * escape sequences that are common in LLM-generated code.
 *
 * Ported from Hermes/OpenCode Python implementation (fuzzy_match.py).
 *
 * The 8-strategy chain (tried in order, first match wins):
 *  1. exact              — Direct string comparison
 *  2. line_trimmed       — Strip leading/trailing whitespace per line
 *  3. whitespace_normalized — Collapse multiple spaces/tabs to a single space
 *  4. indentation_flexible  — Ignore leading indentation entirely
 *  5. escape_normalized     — Convert \n / \t literals to real characters
 *  6. trimmed_boundary      — Trim only the first and last line
 *  7. block_anchor          — Anchor on first+last line, similarity-check middle
 *  8. context_aware         — ≥50 % of lines must have ≥80 % character similarity
 *
 * Unicode normalisation is applied as a pre-processing step in every strategy
 * that does not already do it, and explicitly as strategy "unicode_normalized"
 * (treated as part of the 8-count here, matching the Python numbering).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FuzzyMatchResult {
  success: boolean
  result: string
  strategy: string
  matchCount: number
}

type Match = [number, number] // [start, end] character offsets in content

// ---------------------------------------------------------------------------
// Unicode normalisation
// ---------------------------------------------------------------------------

const UNICODE_MAP: ReadonlyArray<[string, string]> = [
  ['\u201c', '"'],   // left double quote  "
  ['\u201d', '"'],   // right double quote "
  ['\u2018', "'"],   // left single quote  '
  ['\u2019', "'"],   // right single quote '
  ['\u2014', '--'],  // em dash —
  ['\u2013', '-'],   // en dash –
  ['\u2026', '...'], // ellipsis …
  ['\u00a0', ' '],   // non-breaking space
]

function unicodeNormalize(text: string): string {
  for (const [char, repl] of UNICODE_MAP) {
    // replaceAll is available in Node ≥ 15
    text = text.split(char).join(repl)
  }
  return text
}

// ---------------------------------------------------------------------------
// Sequence similarity (LCS-based, mimics Python difflib SequenceMatcher.ratio)
// ---------------------------------------------------------------------------

/**
 * Compute the length of the longest common subsequence of two strings.
 * Uses a memory-optimised rolling-array DP.  For very long strings a
 * word-level approximation is used to bound memory/time.
 */
function lcsLength(a: string, b: string): number {
  if (a === b) return a.length
  if (a.length === 0 || b.length === 0) return 0

  // If the combined length is large, fall back to word-level comparison
  if (a.length * b.length > 500_000) {
    const aWords = a.split(/\s+/)
    const bWords = b.split(/\s+/)
    const wLcs = lcsLengthWords(aWords, bWords)
    // Convert word count back to an approximate character count
    const avgLen = (a.length + b.length) / (aWords.length + bWords.length + 1)
    return Math.round(wLcs * avgLen)
  }

  // Standard two-row DP
  const n = b.length
  let prev = new Array<number>(n + 1).fill(0)
  let curr = new Array<number>(n + 1).fill(0)

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1])
      }
    }
    ;[prev, curr] = [curr, prev]
    curr.fill(0)
  }

  return prev[n]
}

function lcsLengthWords(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const n = b.length
  let prev = new Array<number>(n + 1).fill(0)
  let curr = new Array<number>(n + 1).fill(0)

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1])
      }
    }
    ;[prev, curr] = [curr, prev]
    curr.fill(0)
  }

  return prev[n]
}

/**
 * Return a similarity ratio in [0, 1] between two strings.
 * Formula: 2 * LCS_length / (|a| + |b|) — same as Python SequenceMatcher.ratio().
 */
function sequenceRatio(a: string, b: string): number {
  if (a === b) return 1.0
  if (a.length === 0 && b.length === 0) return 1.0
  if (a.length === 0 || b.length === 0) return 0.0
  return (2 * lcsLength(a, b)) / (a.length + b.length)
}

// ---------------------------------------------------------------------------
// Position helpers
// ---------------------------------------------------------------------------

/**
 * Given an array of lines (without their newline characters) and a half-open
 * range [startLine, endLine), return the [start, end) character offsets in the
 * original joined content string.
 *
 * Mirrors the Python helper `_calculate_line_positions`.
 */
function calculateLinePositions(
  contentLines: string[],
  startLine: number,
  endLine: number,
  contentLength: number
): Match {
  let startPos = 0
  for (let i = 0; i < startLine; i++) {
    startPos += contentLines[i].length + 1 // +1 for the '\n'
  }

  let endPos = 0
  for (let i = 0; i < endLine; i++) {
    endPos += contentLines[i].length + 1
  }
  endPos -= 1 // step back over the trailing newline of the last matched line

  endPos = Math.min(contentLength, endPos)
  return [startPos, endPos]
}

/**
 * Find all non-overlapping occurrences of `pattern` in `text`.
 */
function findAllExact(text: string, pattern: string): Match[] {
  const matches: Match[] = []
  let start = 0
  while (true) {
    const pos = text.indexOf(pattern, start)
    if (pos === -1) break
    matches.push([pos, pos + pattern.length])
    start = pos + 1
  }
  return matches
}

/**
 * Search for `patternNormLines` (one normalised line per element) inside
 * `contentNormLines`, then map the hit back to original character positions.
 */
function findNormalizedMatches(
  content: string,
  contentLines: string[],
  contentNormLines: string[],
  patternNormalized: string
): Match[] {
  const patternNormLines = patternNormalized.split('\n')
  const numPat = patternNormLines.length
  const matches: Match[] = []

  for (let i = 0; i <= contentNormLines.length - numPat; i++) {
    const block = contentNormLines.slice(i, i + numPat).join('\n')
    if (block === patternNormalized) {
      matches.push(calculateLinePositions(contentLines, i, i + numPat, content.length))
    }
  }

  return matches
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/** Strategy 1 — exact string match */
function strategyExact(content: string, pattern: string): Match[] {
  return findAllExact(content, pattern)
}

/** Strategy 2 — strip each line's leading/trailing whitespace before comparing */
function strategyLineTrimmed(content: string, pattern: string): Match[] {
  const patternNorm = pattern
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
  const contentLines = content.split('\n')
  const contentNormLines = contentLines.map((l) => l.trim())
  return findNormalizedMatches(content, contentLines, contentNormLines, patternNorm)
}

/** Strategy 3 — collapse runs of spaces/tabs to a single space */
function strategyWhitespaceNormalized(content: string, pattern: string): Match[] {
  const normalize = (s: string) => s.replace(/[ \t]+/g, ' ')
  const patternNorm = normalize(pattern)
  const contentLines = content.split('\n')
  const contentNormLines = contentLines.map(normalize)
  return findNormalizedMatches(content, contentLines, contentNormLines, patternNorm)
}

/** Strategy 4 — strip all leading whitespace from every line (ignore indentation) */
function strategyIndentationFlexible(content: string, pattern: string): Match[] {
  const patternNorm = pattern
    .split('\n')
    .map((l) => l.trimStart())
    .join('\n')
  const contentLines = content.split('\n')
  const contentNormLines = contentLines.map((l) => l.trimStart())
  return findNormalizedMatches(content, contentLines, contentNormLines, patternNorm)
}

/** Strategy 5 — convert literal \n / \t escape sequences to real characters */
function strategyEscapeNormalized(content: string, pattern: string): Match[] {
  const unescaped = pattern.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
  if (unescaped === pattern) return [] // nothing changed; skip
  return strategyExact(content, unescaped)
}

/** Strategy 6 — trim only the very first and very last line of the pattern */
function strategyTrimmedBoundary(content: string, pattern: string): Match[] {
  const patternLines = pattern.split('\n')
  if (patternLines.length === 0) return []

  const trimmed = [...patternLines]
  trimmed[0] = trimmed[0].trim()
  if (trimmed.length > 1) trimmed[trimmed.length - 1] = trimmed[trimmed.length - 1].trim()
  const patternNorm = trimmed.join('\n')

  const contentLines = content.split('\n')
  const numPat = patternLines.length
  const matches: Match[] = []

  for (let i = 0; i <= contentLines.length - numPat; i++) {
    const block = contentLines.slice(i, i + numPat)
    const checkLines = [...block]
    checkLines[0] = checkLines[0].trim()
    if (checkLines.length > 1) checkLines[checkLines.length - 1] = checkLines[checkLines.length - 1].trim()

    if (checkLines.join('\n') === patternNorm) {
      matches.push(calculateLinePositions(contentLines, i, i + numPat, content.length))
    }
  }

  return matches
}

/** Strategy 7 — unicode normalise, then run exact + line-trimmed matching */
function strategyUnicodeNormalized(content: string, pattern: string): Match[] {
  const normContent = unicodeNormalize(content)
  const normPattern = unicodeNormalize(pattern)
  if (normContent === content && normPattern === pattern) return []

  // Try exact on normalised strings; if no hit, try line-trimmed on normalised
  let normMatches = strategyExact(normContent, normPattern)
  if (normMatches.length === 0) {
    normMatches = strategyLineTrimmed(normContent, normPattern)
  }
  if (normMatches.length === 0) return []

  // Map normalised offsets back to original offsets.
  // Build orig→norm index map (needed because some replacements expand chars,
  // e.g. em-dash "—" → "--" goes from 1 char to 2 chars).
  const origToNorm: number[] = []
  let normPos = 0
  for (const ch of content) {
    origToNorm.push(normPos)
    const repl = UNICODE_MAP.find(([c]) => c === ch)
    normPos += repl ? repl[1].length : 1
  }
  origToNorm.push(normPos) // sentinel

  // Invert: norm position → first original position with that norm index
  const normToOrigStart = new Map<number, number>()
  for (let i = 0; i < origToNorm.length - 1; i++) {
    if (!normToOrigStart.has(origToNorm[i])) normToOrigStart.set(origToNorm[i], i)
  }

  const origLen = content.length
  const result: Match[] = []
  for (const [ns, ne] of normMatches) {
    const os = normToOrigStart.get(ns)
    if (os === undefined) continue
    let oe = os
    while (oe < origLen && origToNorm[oe] < ne) oe++
    result.push([os, oe])
  }

  return result
}

/**
 * Strategy 8 — block anchor: match by first & last line, then similarity-check
 * the middle section.
 */
function strategyBlockAnchor(content: string, pattern: string): Match[] {
  const normPattern = unicodeNormalize(pattern)
  const normContent = unicodeNormalize(content)

  const patternLines = normPattern.split('\n')
  if (patternLines.length < 2) return []

  const firstLine = patternLines[0].trim()
  const lastLine = patternLines[patternLines.length - 1].trim()
  const numPat = patternLines.length

  const normContentLines = normContent.split('\n')
  const origContentLines = content.split('\n')

  // Find candidate start positions
  const candidates: number[] = []
  for (let i = 0; i <= normContentLines.length - numPat; i++) {
    if (
      normContentLines[i].trim() === firstLine &&
      normContentLines[i + numPat - 1].trim() === lastLine
    ) {
      candidates.push(i)
    }
  }

  if (candidates.length === 0) return []

  // Looser threshold for unique candidates, stricter for multiple
  const threshold = candidates.length === 1 ? 0.5 : 0.7

  const matches: Match[] = []
  for (const i of candidates) {
    let similarity: number
    if (numPat <= 2) {
      similarity = 1.0
    } else {
      const contentMiddle = normContentLines.slice(i + 1, i + numPat - 1).join('\n')
      const patternMiddle = patternLines.slice(1, -1).join('\n')
      similarity = sequenceRatio(contentMiddle, patternMiddle)
    }

    if (similarity >= threshold) {
      matches.push(calculateLinePositions(origContentLines, i, i + numPat, content.length))
    }
  }

  return matches
}

/**
 * Strategy 9 (context_aware in Python, #8 in our count) — at least 50 % of
 * lines must have ≥ 80 % character similarity.
 */
function strategyContextAware(content: string, pattern: string): Match[] {
  const patternLines = pattern.split('\n')
  const contentLines = content.split('\n')
  const numPat = patternLines.length

  if (numPat === 0) return []

  const matches: Match[] = []
  for (let i = 0; i <= contentLines.length - numPat; i++) {
    const block = contentLines.slice(i, i + numPat)
    let highSim = 0
    for (let j = 0; j < numPat; j++) {
      const sim = sequenceRatio(patternLines[j].trim(), block[j].trim())
      if (sim >= 0.8) highSim++
    }
    if (highSim >= numPat * 0.5) {
      matches.push(calculateLinePositions(contentLines, i, i + numPat, content.length))
    }
  }

  return matches
}

// ---------------------------------------------------------------------------
// Apply replacements
// ---------------------------------------------------------------------------

function applyReplacements(content: string, matches: Match[], newStr: string): string {
  // Replace from end to start so earlier offsets remain valid
  const sorted = [...matches].sort((a, b) => b[0] - a[0])
  let result = content
  for (const [start, end] of sorted) {
    result = result.slice(0, start) + newStr + result.slice(end)
  }
  return result
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const STRATEGIES: Array<{ name: string; fn: (c: string, p: string) => Match[] }> = [
  { name: 'exact', fn: strategyExact },
  { name: 'line_trimmed', fn: strategyLineTrimmed },
  { name: 'whitespace_normalized', fn: strategyWhitespaceNormalized },
  { name: 'indentation_flexible', fn: strategyIndentationFlexible },
  { name: 'escape_normalized', fn: strategyEscapeNormalized },
  { name: 'trimmed_boundary', fn: strategyTrimmedBoundary },
  { name: 'unicode_normalized', fn: strategyUnicodeNormalized },
  { name: 'block_anchor', fn: strategyBlockAnchor },
  { name: 'context_aware', fn: strategyContextAware },
]

/**
 * Find `oldStr` in `content` using progressively fuzzier strategies and
 * replace it with `newStr`.
 *
 * @param replaceAll  When false (default), multiple matches are an error.
 *                    When true, all occurrences are replaced.
 */
export function fuzzyFindAndReplace(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll = false
): FuzzyMatchResult {
  if (!oldStr) {
    return { success: false, result: content, strategy: '', matchCount: 0 }
  }
  if (oldStr === newStr) {
    return { success: false, result: content, strategy: '', matchCount: 0 }
  }

  for (const { name, fn } of STRATEGIES) {
    const matches = fn(content, oldStr)
    if (matches.length === 0) continue

    if (matches.length > 1 && !replaceAll) {
      // Multiple matches — caller must be more specific
      return { success: false, result: content, strategy: name, matchCount: matches.length }
    }

    const result = applyReplacements(content, matches, newStr)
    return { success: true, result, strategy: name, matchCount: matches.length }
  }

  return { success: false, result: content, strategy: '', matchCount: 0 }
}
