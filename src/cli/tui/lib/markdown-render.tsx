import React from 'react'
import { Box, Text } from 'ink'
import { marked, type Token, type Tokens } from 'marked'

// ANSI escape helpers (no external dep)
const BOLD    = '\x1b[1m'
const ITALIC  = '\x1b[3m'
const DIM     = '\x1b[2m'
const YELLOW  = '\x1b[33m'
const CYAN    = '\x1b[36m'
const RESET   = '\x1b[0m'

/** Apply ANSI inline formatting to a token's text. */
function formatInline(tokens: Token[] | undefined): string {
  if (!tokens || tokens.length === 0) return ''
  return tokens.map(tok => {
    switch (tok.type) {
      case 'strong':     return BOLD + formatInline((tok as Tokens.Strong).tokens) + RESET
      case 'em':         return ITALIC + formatInline((tok as Tokens.Em).tokens) + RESET
      case 'codespan':   return YELLOW + '`' + (tok as Tokens.Codespan).text + '`' + RESET
      case 'link':       return CYAN + (tok as Tokens.Link).text + RESET
      case 'text':       return (tok as Tokens.Text).text
      case 'escape':     return (tok as Tokens.Escape).text
      case 'br':         return '\n'
      default:           return 'raw' in tok ? (tok as { raw: string }).raw : ''
    }
  }).join('')
}

/** Render a top-level block token as a React element. */
function renderToken(token: Token, columns: number, key: number): React.ReactNode {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading
      const prefix = '#'.repeat(t.depth) + ' '
      const text = formatInline(t.tokens)
      return (
        <Box key={key} marginTop={key === 0 ? 0 : 1}>
          <Text bold color="cyan" wrap="wrap">{prefix}{text}</Text>
        </Box>
      )
    }

    case 'paragraph': {
      const t = token as Tokens.Paragraph
      const text = formatInline(t.tokens)
      return (
        <Box key={key} marginTop={key === 0 ? 0 : 1}>
          <Text wrap="wrap">{text}</Text>
        </Box>
      )
    }

    case 'code': {
      const t = token as Tokens.Code
      return (
        <Box key={key} marginTop={key === 0 ? 0 : 1} flexDirection="column" paddingLeft={2}>
          {t.lang && <Text dimColor>{t.lang}</Text>}
          <Text color="yellow" wrap="wrap">{t.text}</Text>
        </Box>
      )
    }

    case 'list': {
      const t = token as Tokens.List
      return (
        <Box key={key} marginTop={key === 0 ? 0 : 1} flexDirection="column">
          {t.items.map((item, i) => {
            const bullet = t.ordered ? `${i + 1}. ` : '• '
            const text = formatInline(item.tokens?.flatMap((tok: Token) =>
              'tokens' in tok && Array.isArray((tok as Tokens.Paragraph).tokens)
                ? (tok as Tokens.Paragraph).tokens!
                : [tok]
            ))
            return (
              <Box key={i}>
                <Text>{bullet}</Text>
                <Text wrap="wrap">{text}</Text>
              </Box>
            )
          })}
        </Box>
      )
    }

    case 'blockquote': {
      const t = token as Tokens.Blockquote
      return (
        <Box key={key} marginTop={key === 0 ? 0 : 1} paddingLeft={2}>
          <Text color="gray" dimColor>│ </Text>
          <Text dimColor wrap="wrap">{t.text}</Text>
        </Box>
      )
    }

    case 'hr':
      return (
        <Box key={key} marginTop={1}>
          <Text dimColor>{'─'.repeat(Math.min(columns - 2, 60))}</Text>
        </Box>
      )

    case 'space':
      return null

    default:
      // Fallback: render raw text
      return (
        <Box key={key}>
          <Text wrap="wrap">{'raw' in token ? (token as { raw: string }).raw : ''}</Text>
        </Box>
      )
  }
}

/**
 * Parse markdown text and return an Ink ReactNode tree.
 * Used both for completed responses and for the streaming suffix.
 */
export function renderMarkdown(text: string, columns: number): React.ReactNode {
  if (!text) return <Text>{''}</Text>

  // Fast path: no markdown syntax → render as plain text
  if (!/[#*`|[>\-_~]|\n\n|^\d+\. /m.test(text)) {
    return <Text wrap="wrap">{text}</Text>
  }

  const tokens = marked.lexer(text)
  const nodes = tokens
    .map((token, i) => renderToken(token, columns, i))
    .filter(Boolean)

  if (nodes.length === 0) return <Text wrap="wrap">{text}</Text>
  if (nodes.length === 1) return nodes[0]

  return <Box flexDirection="column">{nodes}</Box>
}
