// src/cli/tui/gc-renderer/layout.ts
import type { GCNode, LayoutConstraints } from './types.js'
import { padAnsiLine, type ScreenBuffer } from './screen.js'
import chalk from 'chalk'
import wrapAnsi from 'wrap-ansi'
import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'

// ── Text rendering helpers ────────────────────────────────────────────────────

function applyTextStyle(text: string, props: Record<string, unknown>): string {
  let s = text
  if (props['bold'])      s = chalk.bold(s)
  if (props['italic'])    s = chalk.italic(s)
  if (props['dimColor'])  s = chalk.dim(s)
  if (props['underline']) s = chalk.underline(s)
  const color = props['color']
  if (typeof color === 'string') {
    try { s = (chalk as unknown as Record<string, (t: string) => string>)[color]?.(s) ?? s } catch { /* ignore */ }
  }
  const bg = props['backgroundColor']
  if (typeof bg === 'string') {
    const fn = 'bg' + bg[0]!.toUpperCase() + bg.slice(1)
    try { s = (chalk as unknown as Record<string, (t: string) => string>)[fn]?.(s) ?? s } catch { /* ignore */ }
  }
  return s
}

function extractInlineText(node: GCNode): string {
  const parts: string[] = []
  for (const child of node.children) {
    if (child.nodeType === 'gc-textnode') {
      parts.push(child.textContent ?? '')
    } else if (child.nodeType === 'gc-text') {
      parts.push(applyTextStyle(extractInlineText(child), child.props))
    }
  }
  return parts.join('')
}

export function renderTextToLines(node: GCNode, width: number): string[] {
  const raw = applyTextStyle(extractInlineText(node), node.props)
  if (!raw) return []
  const wrap = (node.props['wrap'] as string) ?? 'wrap'
  if (wrap === 'truncate' || wrap === 'end') {
    const vis = stringWidth(stripAnsi(raw))
    if (vis <= width) return [raw]
    return [stripAnsi(raw).slice(0, width - 1) + '…']
  }
  const w = Math.max(1, width)
  return wrapAnsi(raw, w, { hard: false, trim: true, wordWrap: true }).split('\n')
}

// ── Natural height computation (pre-layout) ───────────────────────────────────

function naturalHeight(node: GCNode, availWidth: number): number {
  const mTop = (node.props['marginTop'] as number) ?? 0
  const mBot = (node.props['marginBottom'] as number) ?? 0

  switch (node.nodeType) {
    case 'gc-ansi':    return (node.props['lines'] as string[]).length + mTop + mBot
    case 'gc-separator': return 1 + mTop + mBot
    case 'gc-textnode': return 0
    case 'gc-text': {
      if (node.props['height'] !== undefined) return (node.props['height'] as number) + mTop + mBot
      const pLeft = (node.props['paddingLeft'] as number) ?? 0
      const lines = renderTextToLines(node, Math.max(1, availWidth - pLeft))
      return lines.length + mTop + mBot
    }
    case 'gc-box':
    case 'gc-root': {
      if (node.props['height'] !== undefined) return (node.props['height'] as number) + mTop + mBot
      const fd = (node.props['flexDirection'] as string) ?? 'column'
      const pTop = (node.props['paddingTop'] as number) ?? 0
      const pBot = (node.props['paddingBottom'] as number) ?? 0
      const pLeft = (node.props['paddingLeft'] as number) ?? 0
      const innerW = Math.max(1, availWidth - pLeft)
      if (fd === 'column') {
        const fixed = node.children
          .filter(c => !((c.props['flexGrow'] as number) > 0))
          .reduce((s, c) => s + naturalHeight(c, innerW), 0)
        return fixed + pTop + pBot + mTop + mBot
      }
      const maxH = node.children.reduce((m, c) => Math.max(m, naturalHeight(c, innerW)), 0)
      return maxH + pTop + pBot + mTop + mBot
    }
    default: return 0
  }
}

// ── Layout pass ───────────────────────────────────────────────────────────────

export function layoutTree(node: GCNode, c: LayoutConstraints): void {
  const mTop = (node.props['marginTop'] as number) ?? 0
  const mBot = (node.props['marginBottom'] as number) ?? 0

  node.computedX = c.x
  node.computedY = c.y
  node.computedWidth  = c.availableWidth
  node.computedHeight = c.availableHeight

  if (node.nodeType !== 'gc-box' && node.nodeType !== 'gc-root') return

  const fd    = (node.props['flexDirection'] as string) ?? 'column'
  const pTop  = (node.props['paddingTop']    as number) ?? 0
  const pBot  = (node.props['paddingBottom'] as number) ?? 0
  const pLeft = (node.props['paddingLeft']   as number) ?? 0
  const innerX = c.x + pLeft
  const innerW = Math.max(1, c.availableWidth - pLeft)
  const innerH = Math.max(0, c.availableHeight - pTop - pBot - mTop - mBot)

  if (fd === 'column') {
    const flexChildren   = node.children.filter(c => (c.props['flexGrow'] as number) > 0)
    const fixedTotal     = node.children
      .filter(c => !((c.props['flexGrow'] as number) > 0))
      .reduce((s, ch) => s + naturalHeight(ch, innerW), 0)
    const remaining    = Math.max(0, innerH - fixedTotal)
    const totalFlex    = flexChildren.reduce((s, ch) => s + ((ch.props['flexGrow'] as number) ?? 1), 0)

    let curY = c.y + pTop + mTop
    for (const child of node.children) {
      const cm = (child.props['marginTop'] as number) ?? 0
      const cb = (child.props['marginBottom'] as number) ?? 0
      const fg = (child.props['flexGrow'] as number) ?? 0
      let childH: number
      if (fg > 0 && totalFlex > 0) {
        childH = Math.max(0, Math.floor(remaining * fg / totalFlex))
      } else {
        childH = Math.max(0, naturalHeight(child, innerW) - cm - cb)
      }
      curY += cm
      layoutTree(child, { x: innerX, y: curY, availableWidth: innerW, availableHeight: childH })
      curY += childH + cb
    }
  } else {
    // row
    let curX = innerX
    const count = node.children.length
    for (let i = 0; i < count; i++) {
      const child = node.children[i]!
      const explicitW = child.props['width']
      let childW: number
      if (typeof explicitW === 'number') {
        childW = explicitW
      } else if (i === count - 1) {
        childW = Math.max(0, innerX + innerW - curX)
      } else {
        childW = Math.floor(innerW / count)
      }
      layoutTree(child, { x: curX, y: c.y + pTop, availableWidth: childW, availableHeight: innerH })
      curX += childW
    }
  }
}

// ── Render pass ───────────────────────────────────────────────────────────────

export function renderTree(node: GCNode, screen: ScreenBuffer): void {
  const { computedX, computedY, computedWidth, computedHeight } = node
  const x = Math.max(0, computedX)

  switch (node.nodeType) {
    case 'gc-ansi': {
      const lines = node.props['lines'] as string[]
      for (let i = 0; i < lines.length && i < computedHeight; i++) {
        const line = padAnsiLine(lines[i]!, computedWidth)
        screen.writeLine(computedY + i, x > 0 ? ' '.repeat(x) + line : line)
      }
      break
    }
    case 'gc-separator': {
      const dim = node.props['dimColor'] !== false
      const bar = dim ? chalk.dim('─'.repeat(computedWidth)) : '─'.repeat(computedWidth)
      screen.writeLine(computedY, x > 0 ? ' '.repeat(x) + padAnsiLine(bar, computedWidth) : padAnsiLine(bar, computedWidth))
      break
    }
    case 'gc-text': {
      const pLeft = (node.props['paddingLeft'] as number) ?? 0
      const lines = renderTextToLines(node, Math.max(1, computedWidth - pLeft))
      for (let i = 0; i < lines.length && i < computedHeight; i++) {
        const pre = (x > 0 ? ' '.repeat(x) : '') + (pLeft > 0 ? ' '.repeat(pLeft) : '')
        screen.writeLine(computedY + i, pre + padAnsiLine(lines[i]!, computedWidth - pLeft))
      }
      break
    }
    case 'gc-root':
    case 'gc-box':
      for (const child of node.children) renderTree(child, screen)
      break
    default:
      break
  }
}
