// src/cli/tui/lib/ansi-markdown.ts
/**
 * Chalk-based markdown → ANSI line renderer.
 *
 * Mirrors Claude Code's approach: generate pre-wrapped ANSI strings
 * at the correct terminal width, then render line-by-line in Ink so
 * Ink never needs to re-wrap content.
 */
import { marked, type Token, type Tokens } from 'marked'
import chalk from 'chalk'
import wrapAnsi from 'wrap-ansi'
import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const c = {
  // Headings
  h1: (s: string) => chalk.bold.cyan(s),
  h2: (s: string) => chalk.bold.cyan(s),
  h3: (s: string) => chalk.bold.blue(s),
  h4: (s: string) => chalk.bold(s),
  // Inline
  bold: (s: string) => chalk.bold(s),
  italic: (s: string) => chalk.italic(s),
  boldItalic: (s: string) => chalk.bold.italic(s),
  code: (s: string) => chalk.yellow(s),       // inline code
  link: (s: string) => chalk.cyan.underline(s),
  // Block
  codeBlock: (s: string) => chalk.dim(s),
  blockquote: (s: string) => chalk.dim.italic(s),
  // Structure
  bullet:  chalk.dim('• '),
  hrLine:  (cols: number) => chalk.dim('─'.repeat(Math.max(0, cols))),
}

// ── Inline token formatter ────────────────────────────────────────────────────

function formatInline(tokens: Token[] | undefined): string {
  if (!tokens || tokens.length === 0) return ''
  return tokens.map(tok => {
    switch (tok.type) {
      case 'strong':    return c.bold(formatInline((tok as Tokens.Strong).tokens))
      case 'em':        return c.italic(formatInline((tok as Tokens.Em).tokens))
      case 'strong_em': return c.boldItalic(formatInline((tok as Tokens.Strong).tokens ?? []))
      case 'codespan':  return c.code((tok as Tokens.Codespan).text)
      case 'link':      return c.link((tok as Tokens.Link).text)
      case 'text':      return (tok as Tokens.Text).text
      case 'escape':    return (tok as Tokens.Escape).text
      case 'br':        return '\n'
      default:          return 'raw' in tok ? (tok as { raw: string }).raw : ''
    }
  }).join('')
}

// ── Block token formatter → returns array of wrapped lines ───────────────────

function tokenToLines(token: Token, columns: number, indent = 0): string[] {
  const available = Math.max(1, columns - indent)
  const prefix = indent > 0 ? ' '.repeat(indent) : ''

  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading
      const text = formatInline(t.tokens)
      const styled = t.depth <= 2 ? c.h1(text) : t.depth === 3 ? c.h3(text) : c.h4(text)
      return ['', styled, '']
    }

    case 'paragraph': {
      const t = token as Tokens.Paragraph
      const text = formatInline(t.tokens)
      const wrapped = wrapAnsi(text, available, { hard: false, trim: true, wordWrap: true })
      const lines = wrapped.split('\n')
      return prefix ? lines.map(l => prefix + l) : lines
    }

    case 'code': {
      const t = token as Tokens.Code
      const lines: string[] = []
      if (t.lang) lines.push(chalk.dim(`[${t.lang}]`))
      const codeLines = t.text.split('\n')
      for (const line of codeLines) {
        // Truncate long code lines to available width
        const stripped = stripAnsi(line)
        if (stringWidth(stripped) > available) {
          // Slice by characters until visible width fits
          let truncated = ''
          let w = 0
          for (const char of stripped) {
            const cw = stringWidth(char)
            if (w + cw > available - 1) break
            truncated += char
            w += cw
          }
          lines.push(c.codeBlock(truncated + '…'))
        } else {
          lines.push(c.codeBlock(stripped))
        }
      }
      return lines
    }

    case 'blockquote': {
      const t = token as Tokens.Blockquote
      const inner = t.tokens?.flatMap(child => tokenToLines(child, available - 2)) ?? []
      return inner.map(line => chalk.dim('│ ') + line)
    }

    case 'list': {
      const t = token as Tokens.List
      const lines: string[] = []
      t.items.forEach((item, idx) => {
        const bullet = t.ordered ? chalk.dim(`${idx + 1}. `) : c.bullet
        const bulletWidth = stringWidth(stripAnsi(bullet))
        // First line gets bullet, continuation lines get same indent
        const itemTokens: Token[] = item.tokens ?? []
        const itemLines = itemTokens.flatMap(child => tokenToLines(child, available - bulletWidth, 0))
        itemLines.forEach((line, i) => {
          lines.push(prefix + (i === 0 ? bullet + line : ' '.repeat(bulletWidth) + line))
        })
      })
      return lines
    }

    case 'hr':
      return [c.hrLine(columns)]

    case 'space':
      return ['']

    case 'table': {
      const t = token as Tokens.Table
      // Simple table: render header + separator + rows
      const lines: string[] = []
      const headerCells = t.header.map(cell => formatInline(cell.tokens))
      lines.push(headerCells.join('  │  '))
      lines.push('─'.repeat(Math.min(columns, headerCells.join('  │  ').length + 4)))
      for (const row of t.rows) {
        lines.push(row.map(cell => formatInline(cell.tokens)).join('  │  '))
      }
      return lines
    }

    case 'text': {
      // List item text token: use formatInline to render bold/italic/code
      const t = token as Tokens.Text
      const text = t.tokens ? formatInline(t.tokens) : t.text
      if (!text.trim()) return []
      const wrapped = wrapAnsi(text, available, { hard: false, trim: true, wordWrap: true })
      return prefix ? wrapped.split('\n').map(l => prefix + l) : wrapped.split('\n')
    }

    default: {
      // Fallback: render raw text
      const raw = 'text' in token ? (token as { text: string }).text
                : 'raw' in token ? (token as { raw: string }).raw
                : ''
      if (!raw.trim()) return []
      const wrapped = wrapAnsi(raw, available, { hard: false, trim: true, wordWrap: true })
      return wrapped.split('\n')
    }
  }
}

// ── Fast path: detect markdown syntax ────────────────────────────────────────

const MD_RE = /[#*`|>\-_~\[]|\n\n|^\d+\. /m

function hasMarkdown(s: string): boolean {
  return MD_RE.test(s.length > 600 ? s.slice(0, 600) : s)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Convert markdown text to an array of ANSI-formatted terminal lines.
 * Each line is guaranteed ≤ `columns` visible characters wide.
 * Pass these lines to AnsiBlock for rendering.
 */
export function markdownToAnsiLines(text: string, columns: number): string[] {
  if (!text) return []

  const safeColumns = Math.max(10, columns)

  if (!hasMarkdown(text)) {
    // Plain text: just word-wrap
    const wrapped = wrapAnsi(text, safeColumns, { hard: false, trim: true, wordWrap: true })
    return wrapped.split('\n')
  }

  try {
    const tokens = marked.lexer(text)
    const lines = tokens.flatMap(tok => tokenToLines(tok, safeColumns))
    // Trim leading/trailing empty lines
    let start = 0
    while (start < lines.length && lines[start]?.trim() === '') start++
    let end = lines.length - 1
    while (end > start && lines[end]?.trim() === '') end--
    return lines.slice(start, end + 1)
  } catch {
    // Fallback to plain text on parse error
    return wrapAnsi(text, safeColumns, { hard: false, trim: true }).split('\n')
  }
}
