// src/cli/tui/gc-renderer/layout.ts
// Two-pass flexbox layout engine for the gc-renderer.
// Pass 1 (measure): naturalWidth / naturalHeight — intrinsic sizes.
// Pass 2 (layout):  layoutTree — assigns computedX/Y/Width/Height.
// Render:           renderTree — writes to ScreenBuffer with optional Y-clipping.

import type { GCNode, LayoutConstraints } from './types.js'
import { padAnsiLine, type ScreenBuffer } from './screen.js'
import chalk from 'chalk'
import wrapAnsi from 'wrap-ansi'
import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'

// ── Text rendering ────────────────────────────────────────────────────────────

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
  const w = Math.max(1, width)
  const wrap = (node.props['wrap'] as string) ?? 'wrap'
  if (wrap === 'truncate' || wrap === 'end') {
    const vis = stringWidth(stripAnsi(raw))
    if (vis <= w) return [raw]
    const truncated = wrapAnsi(raw, w, { hard: true, trim: false }).split('\n')[0] ?? ''
    return [truncated + '\x1b[0m']
  }
  return wrapAnsi(raw, w, { hard: false, trim: true, wordWrap: true }).split('\n')
}

// ── Measure pass (Pass 1) ─────────────────────────────────────────────────────

/** Intrinsic width of a node given the available column width. */
export function naturalWidth(node: GCNode, availWidth: number): number {
  const pLeft  = (node.props['paddingLeft']  as number) ?? 0
  const pRight = (node.props['paddingRight'] as number) ?? 0
  const innerW = Math.max(1, availWidth - pLeft - pRight)

  switch (node.nodeType) {
    case 'gc-ansi':
      return (node.props['width'] as number) ?? 0

    case 'gc-separator':
      return availWidth  // always fills

    case 'gc-textnode':
      return stringWidth(stripAnsi(node.textContent ?? ''))

    case 'gc-text': {
      if (node.props['width'] !== undefined) return node.props['width'] as number
      const rendered = renderTextToLines(node, innerW)
      return Math.max(0, ...rendered.map(l => stringWidth(stripAnsi(l))))
    }

    case 'gc-box':
    case 'gc-root': {
      if (node.props['width'] !== undefined) {
        const w = node.props['width']
        if (typeof w === 'number') return w
        if (w === '100%') return availWidth
      }
      const fd  = (node.props['flexDirection'] as string) ?? 'column'
      const gap = (node.props['gap'] as number) ?? 0
      const childW = node.children.map(c => naturalWidth(c, innerW))
      if (fd === 'row') {
        const total = childW.reduce((s, w) => s + w, 0)
        const gaps  = Math.max(0, node.children.length - 1) * gap
        return total + gaps + pLeft + pRight
      }
      // column: max child width
      return Math.max(0, ...childW) + pLeft + pRight
    }

    default:
      return 0
  }
}

/** Intrinsic height of a node given the available column width. */
function naturalHeight(node: GCNode, availWidth: number): number {
  const mTop = (node.props['marginTop']    as number) ?? 0
  const mBot = (node.props['marginBottom'] as number) ?? 0
  const pLeft  = (node.props['paddingLeft']  as number) ?? 0
  const pRight = (node.props['paddingRight'] as number) ?? 0
  const innerW = Math.max(1, availWidth - pLeft - pRight)

  switch (node.nodeType) {
    case 'gc-ansi':
      return (node.props['lines'] as string[]).length + mTop + mBot

    case 'gc-separator':
      return 1 + mTop + mBot

    case 'gc-textnode':
      return 0

    case 'gc-text': {
      if (node.props['height'] !== undefined) return (node.props['height'] as number) + mTop + mBot
      return renderTextToLines(node, innerW).length + mTop + mBot
    }

    case 'gc-box':
    case 'gc-root': {
      if (node.props['height'] !== undefined) return (node.props['height'] as number) + mTop + mBot
      const fd   = (node.props['flexDirection'] as string) ?? 'column'
      const pTop = (node.props['paddingTop']    as number) ?? 0
      const pBot = (node.props['paddingBottom'] as number) ?? 0
      const gap  = (node.props['gap']           as number) ?? 0

      if (fd === 'column') {
        const fixed = node.children
          .filter(c => !((c.props['flexGrow'] as number) > 0))
          .reduce((s, c) => s + naturalHeight(c, innerW), 0)
        const gaps = Math.max(0, node.children.length - 1) * gap
        return fixed + gaps + pTop + pBot + mTop + mBot
      }
      // row: max child height
      const maxH = Math.max(0, ...node.children.map(c => naturalHeight(c, innerW) - ((c.props['marginTop'] as number) ?? 0) - ((c.props['marginBottom'] as number) ?? 0)))
      return maxH + pTop + pBot + mTop + mBot
    }

    default:
      return 0
  }
}

// ── Layout pass (Pass 2) ──────────────────────────────────────────────────────

export function layoutTree(node: GCNode, c: LayoutConstraints): void {
  node.computedX      = c.x
  node.computedY      = c.y
  node.computedWidth  = c.availableWidth
  node.computedHeight = c.availableHeight

  if (node.nodeType !== 'gc-box' && node.nodeType !== 'gc-root') return

  const fd  = (node.props['flexDirection']  as string) ?? 'column'
  const jc  = (node.props['justifyContent'] as string) ?? 'flex-start'
  const ai  = (node.props['alignItems']     as string) ?? 'stretch'
  const gap = (node.props['gap']            as number) ?? 0
  const pTop   = (node.props['paddingTop']    as number) ?? 0
  const pBot   = (node.props['paddingBottom'] as number) ?? 0
  const pLeft  = (node.props['paddingLeft']   as number) ?? 0
  const pRight = (node.props['paddingRight']  as number) ?? 0
  const mTop   = (node.props['marginTop']     as number) ?? 0
  const mBot   = (node.props['marginBottom']  as number) ?? 0

  const innerX = c.x + pLeft
  const innerW = Math.max(1, c.availableWidth - pLeft - pRight)
  const innerH = Math.max(0, c.availableHeight - pTop - pBot - mTop - mBot)
  const innerY = c.y + pTop + mTop

  if (fd === 'column') {
    _layoutColumn(node, innerX, innerY, innerW, innerH, gap, jc)
  } else {
    _layoutRow(node, innerX, innerY, innerW, innerH, gap, jc, ai)
  }
}

function _layoutColumn(
  node: GCNode,
  x: number, y: number,
  availW: number, availH: number,
  gap: number, jc: string,
): void {
  const children = node.children

  // Separate flex-grow children from fixed children
  const flexChildren  = children.filter(c => (c.props['flexGrow'] as number) > 0)
  const fixedChildren = children.filter(c => !((c.props['flexGrow'] as number) > 0))

  // Compute fixed total (include margins)
  const fixedTotal = fixedChildren.reduce((s, c) => s + naturalHeight(c, availW), 0)
  const totalGaps  = Math.max(0, children.length - 1) * gap
  const remaining  = Math.max(0, availH - fixedTotal - totalGaps)
  const totalFlex  = flexChildren.reduce((s, c) => s + ((c.props['flexGrow'] as number) ?? 1), 0)

  // Compute each child's height
  const heights = children.map(c => {
    const fg = (c.props['flexGrow'] as number) ?? 0
    if (fg > 0 && totalFlex > 0) {
      return Math.max(0, Math.floor(remaining * fg / totalFlex))
    }
    const mT = (c.props['marginTop']    as number) ?? 0
    const mB = (c.props['marginBottom'] as number) ?? 0
    return Math.max(0, naturalHeight(c, availW) - mT - mB)
  })

  // For justifyContent in column:
  const totalContentH = heights.reduce((s, h) => s + h, 0) + totalGaps
  let startY: number
  switch (jc) {
    case 'flex-end':   startY = y + availH - totalContentH; break
    case 'center':     startY = y + Math.floor((availH - totalContentH) / 2); break
    default:           startY = y  // flex-start
  }

  if (jc === 'space-between' && children.length > 1) {
    // Distribute remaining space evenly between children (not before first / after last)
    const totalH = heights.reduce((s, h) => s + h, 0)
    const spacePerGap = Math.floor((availH - totalH) / (children.length - 1))
    let curY = y
    children.forEach((child, i) => {
      const mT = (child.props['marginTop']    as number) ?? 0
      const mB = (child.props['marginBottom'] as number) ?? 0
      curY += mT
      layoutTree(child, { x, y: curY, availableWidth: availW, availableHeight: heights[i]! })
      curY += heights[i]! + mB
      if (i < children.length - 1) curY += spacePerGap
    })
  } else {
    let curY = startY
    children.forEach((child, i) => {
      const mT = (child.props['marginTop']    as number) ?? 0
      const mB = (child.props['marginBottom'] as number) ?? 0
      curY += mT
      layoutTree(child, { x, y: curY, availableWidth: availW, availableHeight: heights[i]! })
      curY += heights[i]! + mB
      if (i < children.length - 1) curY += gap
    })
  }
}

function _layoutRow(
  node: GCNode,
  x: number, y: number,
  availW: number, availH: number,
  gap: number, jc: string, ai: string,
): void {
  const children = node.children
  if (children.length === 0) return

  // Compute each child's natural width (for non-flex) or flex share
  const flexChildren  = children.filter(c => (c.props['flexGrow'] as number) > 0)
  const fixedChildren = children.filter(c => !((c.props['flexGrow'] as number) > 0))

  const totalGaps  = Math.max(0, children.length - 1) * gap
  const fixedTotal = fixedChildren.reduce((s, c) => s + naturalWidth(c, availW), 0)
  const remaining  = Math.max(0, availW - fixedTotal - totalGaps)
  const totalFlex  = flexChildren.reduce((s, c) => s + ((c.props['flexGrow'] as number) ?? 1), 0)

  const widths = children.map(c => {
    const fg = (c.props['flexGrow'] as number) ?? 0
    if (fg > 0 && totalFlex > 0) return Math.max(0, Math.floor(remaining * fg / totalFlex))
    return naturalWidth(c, availW)
  })

  // Compute childHeights for alignItems
  const childHeights = children.map((c, i) => {
    if (ai === 'stretch') return availH
    return naturalHeight(c, widths[i]!)
  })

  // Starting X based on justifyContent
  const totalContentW = widths.reduce((s, w) => s + w, 0) + totalGaps
  let startX: number
  switch (jc) {
    case 'flex-end':   startX = x + availW - totalContentW; break
    case 'center':     startX = x + Math.floor((availW - totalContentW) / 2); break
    default:           startX = x  // flex-start
  }

  if (jc === 'space-between' && children.length > 1) {
    const totalW = widths.reduce((s, w) => s + w, 0)
    const spacePerGap = Math.floor((availW - totalW) / (children.length - 1))
    let curX = x
    children.forEach((child, i) => {
      const childY = _alignItemsY(y, availH, childHeights[i]!, ai)
      layoutTree(child, { x: curX, y: childY, availableWidth: widths[i]!, availableHeight: childHeights[i]! })
      curX += widths[i]!
      if (i < children.length - 1) curX += spacePerGap
    })
  } else {
    let curX = startX
    children.forEach((child, i) => {
      const childY = _alignItemsY(y, availH, childHeights[i]!, ai)
      layoutTree(child, { x: curX, y: childY, availableWidth: widths[i]!, availableHeight: childHeights[i]! })
      curX += widths[i]!
      if (i < children.length - 1) curX += gap
    })
  }
}

function _alignItemsY(parentY: number, parentH: number, childH: number, ai: string): number {
  switch (ai) {
    case 'flex-end':  return parentY + parentH - childH
    case 'center':    return parentY + Math.floor((parentH - childH) / 2)
    default:          return parentY  // flex-start / stretch
  }
}

// ── Render pass ───────────────────────────────────────────────────────────────

/** Walk the tree and write each node's content to the ScreenBuffer.
 *  clipMaxY: rows at y >= clipMaxY are not written (enforces overflowY:hidden). */
export function renderTree(node: GCNode, screen: ScreenBuffer, clipMaxY = Infinity): void {
  // Skip entirely if the node starts at or below the clip boundary
  if (node.computedY >= clipMaxY) return

  const { computedX, computedY, computedWidth } = node
  const x = Math.max(0, computedX)

  switch (node.nodeType) {
    case 'gc-ansi': {
      const lines = node.props['lines'] as string[]
      for (let i = 0; i < lines.length; i++) {
        const y = computedY + i
        if (y >= clipMaxY) break
        const line = padAnsiLine(lines[i]!, computedWidth)
        screen.writeLine(y, x > 0 ? ' '.repeat(x) + line : line)
      }
      break
    }

    case 'gc-separator': {
      if (computedY >= clipMaxY) break
      const dim = node.props['dimColor'] !== false
      const bar = dim
        ? chalk.dim('─'.repeat(Math.max(0, computedWidth)))
        : '─'.repeat(Math.max(0, computedWidth))
      const padded = padAnsiLine(bar, computedWidth)
      screen.writeLine(computedY, x > 0 ? ' '.repeat(x) + padded : padded)
      break
    }

    case 'gc-text': {
      const pLeft = (node.props['paddingLeft'] as number) ?? 0
      const w = Math.max(1, computedWidth - pLeft)
      const lines = renderTextToLines(node, w)
      for (let i = 0; i < lines.length; i++) {
        const y = computedY + i
        if (y >= clipMaxY) break
        const pre = (x > 0 ? ' '.repeat(x) : '') + (pLeft > 0 ? ' '.repeat(pLeft) : '')
        screen.writeLine(y, pre + padAnsiLine(lines[i]!, w))
      }
      break
    }

    case 'gc-root':
    case 'gc-box': {
      // Compute effective clip for children
      const overflow = node.props['overflowY'] as string
      const myClip = (overflow === 'hidden')
        ? Math.min(clipMaxY, node.computedY + node.computedHeight)
        : clipMaxY
      for (const child of node.children) {
        renderTree(child, screen, myClip)
      }
      break
    }

    default:
      break
  }
}
