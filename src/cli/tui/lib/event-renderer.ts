// src/cli/tui/lib/event-renderer.ts
// Converts TuiEvent objects to arrays of ANSI-formatted terminal lines.
// Used by message-list.tsx for virtual scroll: all events are pre-rendered
// to ANSI strings, then sliced to the visible viewport.

import chalk from 'chalk'
import wrapAnsi from 'wrap-ansi'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import { markdownToAnsiLines } from './ansi-markdown.js'
import type { TuiEvent } from '../types.js'

const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']

function fmtTokens(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Truncate a plain string to at most maxWidth visible chars. */
function truncate(s: string, maxWidth: number): string {
  const plain = stripAnsi(s)
  if (stringWidth(plain) <= maxWidth) return s
  return plain.slice(0, maxWidth - 1) + '…'
}

/** Wrap plain text to columns, return lines. */
function wrapPlain(text: string, columns: number): string[] {
  return wrapAnsi(text, columns, { hard: false, trim: true, wordWrap: true }).split('\n')
}

/**
 * Convert a single TuiEvent to an array of ANSI-formatted terminal lines.
 * Returns [] for events that render nothing (deltas, invisible events).
 */
export function renderEventToAnsiLines(event: TuiEvent, columns: number): string[] {
  switch (event.kind) {
    case 'user_message': {
      const prompt = chalk.bold.yellow('❯ ')
      const textLines = wrapPlain(event.content, columns - 2)
      return [
        '',
        prompt + textLines[0],
        ...textLines.slice(1).map(l => '  ' + l),
      ]
    }

    case 'response': {
      const mdLines = markdownToAnsiLines(event.content, columns - 2)
      return ['', ...mdLines.map(l => '  ' + l)]
    }

    case 'tool_start': {
      const argsStr = JSON.stringify(event.args ?? {})
      const preview = truncate(argsStr, columns - event.name.length - 6)
      return [
        chalk.magenta.dim('⬡ ') + chalk.magenta.bold(event.name) + chalk.dim(' ' + preview),
      ]
    }

    case 'tool_end': {
      const icon = event.isError ? chalk.red('✗') : chalk.green('✓')
      const dur  = chalk.dim(`${event.durationMs}ms`)
      const header = `  ${icon} ${chalk.magenta(event.name)} ${dur}`
      const preview = event.result
        ? (event.result.length > 200 ? event.result.slice(0, 200) + '…' : event.result)
        : ''
      const resultLines = preview
        ? wrapPlain(preview, columns - 4).map(l => chalk.dim('    ' + l))
        : []
      return [header, ...resultLines]
    }

    case 'thinking_end': {
      const secs = Math.max(1, Math.round(event.durationMs / 1000))
      const header = chalk.dim.italic(`∴ Thought for ${secs}s`)
      if (!event.content) return [header]
      const preview = event.content.length > 300
        ? event.content.slice(0, 300) + '…'
        : event.content
      const mdLines = markdownToAnsiLines(preview, columns - 2)
      return ['', header, ...mdLines.map(l => '  ' + l)]
    }

    case 'agent_end': {
      const turns = event.totalTurns
      const usage = event.usage
        ? ` · in:${fmtTokens(event.usage.inputTokens)} out:${fmtTokens(event.usage.outputTokens)}`
        : ''
      return [chalk.dim(`✓ ${turns} turns · ${event.stopReason}${usage}`)]
    }

    case 'error':
      return [chalk.red(`✗ ${event.message}`)]

    case 'system':
      return event.message ? [chalk.dim(event.message)] : []

    case 'guardrail_warn':
      return [chalk.yellow.dim(`⚠ [${event.toolName}]: ${event.message}`)]

    case 'guardrail_halt':
      return [chalk.red(`✗ HALT [${event.toolName}]: ${event.message}`)]

    case 'diff':
      // Diffs are rendered inline as ANSI — generate a compact representation
      return [chalk.dim(`≡ diff: ${event.filename}`)]

    // These render nothing (they're streaming intermediates)
    case 'delta':
    case 'turn_end':
    case 'turn_start':
    case 'thinking_delta':
      return []

    default:
      return []
  }
}

/** Single-line thinking spinner. Returns '' when not streaming. */
export function renderThinkingLine(
  isStreaming: boolean,
  elapsedMs: number,
  thinkingStartMs: number,
): string {
  if (!isStreaming) return ''
  const frame = Math.floor(Date.now() / 100) % SPINNER_FRAMES.length
  const spinner = SPINNER_FRAMES[frame]!
  const secs = thinkingStartMs > 0
    ? Math.floor((Date.now() - thinkingStartMs) / 1000)
    : Math.floor(elapsedMs / 1000)
  return chalk.dim.italic(`∴ ${spinner} Thinking… (${secs}s)`)
}
