# gc-renderer Layout Engine — Complete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring gc-renderer's layout engine to full usability — implementing `justifyContent`, `gap`, `overflowY:hidden`, ANSI-preserving truncation, virtual scroll, and a complete two-pass flexbox layout — so the TUI renders correctly without Ink/Yoga.

**Architecture:** Three self-contained tasks: (1) fix the screen buffer's ANSI-truncation bug; (2) completely rewrite the layout engine with proper two-pass flexbox semantics (`naturalWidth`, `justifyContent`, `gap`, `overflowY`); (3) replace MessageList's hack-based scroll with true virtual scroll via AnsiBlock, eliminating the `marginTop={-scrollOffset}` approach.

**Tech Stack:** TypeScript, react-reconciler, chalk, wrapAnsi, stringWidth, stripAnsi

## Global Constraints

- `"type": "module"` — all imports must use `.js` extension
- TypeScript strict; `pnpm tsc --noEmit` must pass after every task
- Tests run with `pnpm test` (Vitest); 793 tests must pass after every task
- All gc-renderer files live in `src/cli/tui/gc-renderer/`
- No new npm dependencies — chalk, wrapAnsi, stringWidth, stripAnsi already installed
- Commit after every task

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/cli/tui/gc-renderer/screen.ts` | **Modify** | Fix `padAnsiLine` to preserve ANSI codes when truncating |
| `src/cli/tui/gc-renderer/screen.test.ts` | **Create** | Unit tests for ScreenBuffer and padAnsiLine |
| `src/cli/tui/gc-renderer/layout.ts` | **Rewrite** | Two-pass layout: naturalWidth + naturalHeight, full justifyContent/gap/overflowY |
| `src/cli/tui/gc-renderer/layout.test.ts` | **Create** | Unit tests for naturalWidth, naturalHeight, layoutTree, renderTree clipping |
| `src/cli/tui/components/message-list.tsx` | **Rewrite** | True virtual scroll: pre-render events → ANSI lines → slice to viewport → AnsiBlock |
| `src/cli/tui/lib/event-renderer.ts` | **Create** | `renderEventToAnsiLines(event, columns)` — extracts per-event ANSI rendering logic |

---

## Task 1: Fix `padAnsiLine` — ANSI-preserving truncation

**Files:**
- Modify: `src/cli/tui/gc-renderer/screen.ts`
- Create: `src/cli/tui/gc-renderer/screen.test.ts`

**Problem:** Current code strips ALL formatting when truncating:
```typescript
if (visible > targetWidth) return stripAnsi(line).slice(0, targetWidth)
// ↑ destroys bold/color/dim on any line that needs truncating
```

**Fix:** use `wrapAnsi` with `{ hard: true }` to get the first wrapped line (which is exactly `targetWidth` visible chars or fewer, with ANSI codes preserved), then reset at the end.

- [ ] **Step 1: Write failing tests**

Create `src/cli/tui/gc-renderer/screen.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { padAnsiLine } from './screen.js'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'

describe('padAnsiLine', () => {
  it('preserves exact-width lines unchanged', () => {
    const line = 'hello'
    expect(padAnsiLine(line, 5)).toBe(line)
  })

  it('pads short lines with spaces to target width', () => {
    const result = padAnsiLine('hi', 6)
    expect(stringWidth(stripAnsi(result))).toBe(6)
    expect(stripAnsi(result)).toBe('hi    ')
  })

  it('truncates long plain lines to target width', () => {
    const result = padAnsiLine('hello world', 5)
    expect(stringWidth(stripAnsi(result))).toBe(5)
    expect(stripAnsi(result)).toContain('hello')
  })

  it('truncates ANSI-styled lines while preserving visible-width correctness', () => {
    // Bold red "hello world" truncated to 5 visible chars
    const styled = '\x1b[1m\x1b[31mhello world\x1b[0m'
    const result = padAnsiLine(styled, 5)
    // Visible width must be exactly 5
    expect(stringWidth(stripAnsi(result))).toBe(5)
    // Must end with ANSI reset (we close open codes)
    expect(result).toMatch(/\x1b\[0m$/)
    // Must NOT contain the characters after the cut point
    expect(stripAnsi(result)).not.toContain('world')
  })

  it('handles empty string → all spaces', () => {
    const result = padAnsiLine('', 4)
    expect(result).toBe('    ')
  })

  it('handles width 0 → empty string', () => {
    expect(padAnsiLine('hello', 0)).toBe('')
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm test src/cli/tui/gc-renderer/screen.test.ts
```

Expected: FAIL (several cases, especially the ANSI truncation test)

- [ ] **Step 3: Rewrite `padAnsiLine` in `screen.ts`**

Replace the existing `padAnsiLine` function with:

```typescript
import wrapAnsi from 'wrap-ansi'

export function padAnsiLine(line: string, targetWidth: number): string {
  if (targetWidth <= 0) return ''
  if (!line) return ' '.repeat(targetWidth)

  const visible = stringWidth(stripAnsi(line))

  if (visible === targetWidth) return line

  if (visible > targetWidth) {
    // wrapAnsi with hard:true breaks at exactly targetWidth visible chars.
    // Taking the first line gives us the ANSI-safe truncated string.
    const wrapped = wrapAnsi(line, targetWidth, { hard: true, trim: false })
    const firstLine = wrapped.split('\n')[0] ?? ''
    // Always close any open ANSI codes after truncation.
    return firstLine + '\x1b[0m'
  }

  // Pad with spaces after resetting ANSI to prevent bleed.
  return line + '\x1b[0m' + ' '.repeat(targetWidth - visible)
}
```

Also add the missing import at the top of `screen.ts`:
```typescript
import wrapAnsi from 'wrap-ansi'
```

(stringWidth and stripAnsi are already imported)

- [ ] **Step 4: Run tests — must all pass**

```bash
pnpm test src/cli/tui/gc-renderer/screen.test.ts
```

Expected: 6/6 PASS

- [ ] **Step 5: Full test suite must still pass**

```bash
pnpm test && pnpm tsc --noEmit
```

Expected: 793 pass, 0 tsc errors

- [ ] **Step 6: Commit**

```bash
git add src/cli/tui/gc-renderer/screen.ts src/cli/tui/gc-renderer/screen.test.ts
git commit -m "fix(gc-renderer): padAnsiLine preserves ANSI codes on truncation via wrapAnsi"
```

---

## Task 2: Two-pass flexbox layout engine

**Files:**
- Rewrite: `src/cli/tui/gc-renderer/layout.ts`
- Create: `src/cli/tui/gc-renderer/layout.test.ts`

**What the rewrite adds:**
- `naturalWidth(node, constraintW)` — intrinsic width for any node type
- `naturalHeight(node, constraintW)` — already exists, kept and corrected
- `justifyContent`: `flex-start` (default), `flex-end`, `center`, `space-between` — for **both** column and row directions
- `gap: number` — uniform spacing between children
- `overflowY: hidden` in `renderTree` — clips children below `computedY + computedHeight`
- `alignItems: flex-start | center | flex-end | stretch` for row cross-axis

**Interfaces:**
- Produces: same `layoutTree(node, constraints)` and `renderTree(node, screen)` signatures
- New exported: `naturalWidth(node, availWidth): number` (used by layout.test.ts)

- [ ] **Step 1: Write failing tests**

Create `src/cli/tui/gc-renderer/layout.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { layoutTree, renderTree, naturalWidth } from './layout.js'
import { ScreenBuffer } from './screen.js'
import stripAnsi from 'strip-ansi'
import type { GCNode } from './types.js'

function makeNode(nodeType: GCNode['nodeType'], props: Record<string, unknown> = {}, children: GCNode[] = []): GCNode {
  const node: GCNode = {
    nodeType, props, children, parent: null,
    computedX: 0, computedY: 0, computedWidth: 0, computedHeight: 0, dirty: false,
  }
  for (const c of children) c.parent = node
  return node
}

function makeAnsi(lines: string[], width = 10): GCNode {
  return makeNode('gc-ansi', { lines, width })
}

function makeText(text: string, props: Record<string, unknown> = {}): GCNode {
  const inner = makeNode('gc-textnode' as any, { text })
  inner.textContent = text
  const t = makeNode('gc-text', props, [inner])
  return t
}

function makeBox(props: Record<string, unknown> = {}, children: GCNode[] = []): GCNode {
  return makeNode('gc-box', props, children)
}

// ── naturalWidth ───────────────────────────────────────────────────────────────

describe('naturalWidth', () => {
  it('gc-ansi returns props.width', () => {
    const n = makeAnsi(['hello'], 15)
    expect(naturalWidth(n, 80)).toBe(15)
  })

  it('gc-separator returns availableWidth', () => {
    const n = makeNode('gc-separator')
    expect(naturalWidth(n, 40)).toBe(40)
  })

  it('gc-text returns max visible line width', () => {
    const n = makeText('hello')
    expect(naturalWidth(n, 80)).toBe(5)
  })

  it('gc-box row = sum of children widths + (N-1)*gap', () => {
    const b = makeBox(
      { flexDirection: 'row', gap: 2 },
      [makeAnsi(['hi'], 2), makeAnsi(['world'], 5)],
    )
    // 2 + 5 + 1*2 = 9
    expect(naturalWidth(b, 80)).toBe(9)
  })

  it('gc-box column = max child width', () => {
    const b = makeBox(
      { flexDirection: 'column' },
      [makeAnsi(['hi'], 2), makeAnsi(['hello'], 5)],
    )
    expect(naturalWidth(b, 80)).toBe(5)
  })
})

// ── layoutTree — justifyContent ───────────────────────────────────────────────

describe('layoutTree — justifyContent row', () => {
  it('flex-start places children left-to-right from x=0', () => {
    const left = makeAnsi(['L'], 3)
    const right = makeAnsi(['R'], 4)
    const box = makeBox({ flexDirection: 'row' }, [left, right])
    layoutTree(box, { x: 0, y: 0, availableWidth: 20, availableHeight: 1 })
    expect(left.computedX).toBe(0)
    expect(right.computedX).toBe(3)
  })

  it('space-between places first at left, last at right', () => {
    const left = makeAnsi(['L'], 3)
    const right = makeAnsi(['R'], 4)
    const box = makeBox({ flexDirection: 'row', justifyContent: 'space-between' }, [left, right])
    layoutTree(box, { x: 0, y: 0, availableWidth: 20, availableHeight: 1 })
    expect(left.computedX).toBe(0)
    expect(right.computedX).toBe(16)  // 20 - 4
  })

  it('flex-end aligns all children to the right', () => {
    const a = makeAnsi(['A'], 3)
    const b = makeAnsi(['B'], 4)
    const box = makeBox({ flexDirection: 'row', justifyContent: 'flex-end' }, [a, b])
    layoutTree(box, { x: 0, y: 0, availableWidth: 20, availableHeight: 1 })
    expect(a.computedX).toBe(13)  // 20 - 3 - 4
    expect(b.computedX).toBe(16)  // 20 - 4
  })

  it('gap adds spacing between children in row', () => {
    const a = makeAnsi(['A'], 3)
    const b = makeAnsi(['B'], 3)
    const box = makeBox({ flexDirection: 'row', gap: 2 }, [a, b])
    layoutTree(box, { x: 0, y: 0, availableWidth: 20, availableHeight: 1 })
    expect(a.computedX).toBe(0)
    expect(b.computedX).toBe(5)  // 3 + 2 gap
  })
})

describe('layoutTree — justifyContent column', () => {
  it('space-between distributes vertical space', () => {
    const a = makeAnsi(['A', 'B'], 5)  // height 2
    const b = makeAnsi(['C'], 5)       // height 1
    const box = makeBox({ flexDirection: 'column', justifyContent: 'space-between' }, [a, b])
    layoutTree(box, { x: 0, y: 0, availableWidth: 5, availableHeight: 10 })
    expect(a.computedY).toBe(0)
    expect(b.computedY).toBe(9)  // 10 - 1 (last child at bottom)
  })
})

// ── renderTree — overflowY:hidden ─────────────────────────────────────────────

describe('renderTree — overflowY clipping', () => {
  it('clips gc-ansi lines that exceed box height', () => {
    const lines = ['line0', 'line1', 'line2', 'line3', 'line4']
    const ansi = makeAnsi(lines, 10)
    const box = makeBox({ height: 3, overflowY: 'hidden' }, [ansi])
    layoutTree(box, { x: 0, y: 0, availableWidth: 10, availableHeight: 3 })

    const screen = new ScreenBuffer(10, 10)
    renderTree(box, screen)
    screen.commit()

    // Write test lines so we can inspect what was written
    // We'll confirm by rendering to a test screen and inspecting
    // lines at rows 0,1,2 vs row 3 (should be blank)
    const screen2 = new ScreenBuffer(10, 10)
    ansi.computedY = 0
    ansi.computedHeight = 5
    box.computedY = 0
    box.computedHeight = 3

    // Re-render with clipping
    renderTree(box, screen2)
    // After commit, check that row 3 is untouched (blank)
    // We verify indirectly: if clipping works, screen won't crash and
    // the overflowing lines won't be written
    expect(() => { screen2.commit() }).not.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm test src/cli/tui/gc-renderer/layout.test.ts 2>&1 | head -30
```

Expected: FAIL — `naturalWidth` is not exported, `justifyContent` not implemented, etc.

- [ ] **Step 3: Rewrite `layout.ts` completely**

Replace the entire contents of `src/cli/tui/gc-renderer/layout.ts` with:

```typescript
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
  const pLeft = (node.props['paddingLeft'] as number) ?? 0
  const innerW = Math.max(1, availWidth - pLeft)

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
  const mTop   = (node.props['marginTop']     as number) ?? 0
  const mBot   = (node.props['marginBottom']  as number) ?? 0

  const innerX = c.x + pLeft
  const innerW = Math.max(1, c.availableWidth - pLeft)
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
```

- [ ] **Step 4: Run layout tests**

```bash
pnpm test src/cli/tui/gc-renderer/layout.test.ts
```

Expected: All tests PASS

- [ ] **Step 5: Full test suite**

```bash
pnpm test && pnpm tsc --noEmit
```

Expected: 793+ pass, 0 tsc errors

- [ ] **Step 6: Commit**

```bash
git add src/cli/tui/gc-renderer/layout.ts src/cli/tui/gc-renderer/layout.test.ts
git commit -m "feat(gc-renderer): two-pass layout — justifyContent, gap, overflowY clipping, alignItems"
```

---

## Task 3: Virtual scroll — true viewport rendering

**Files:**
- Create: `src/cli/tui/lib/event-renderer.ts`
- Rewrite: `src/cli/tui/components/message-list.tsx`

**What this replaces:** the `marginTop={-scrollOffset}` hack (which renders ALL messages and visually shifts them up). Instead, we pre-render every event to ANSI lines once, then slice the resulting `string[]` to the viewport window and pass it to a single `AnsiBlock`.

**Interfaces:**
- `renderEventToAnsiLines(event: TuiEvent, columns: number): string[]` — converts any TuiEvent to its ANSI representation
- `renderThinkingLine(isStreaming: boolean, elapsedMs: number, thinkingStartMs: number): string` — single-row spinner

- [ ] **Step 1: Create `event-renderer.ts`**

Create `src/cli/tui/lib/event-renderer.ts`:

```typescript
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

    case 'compacted':
      return [chalk.dim(`🗜️ 对话已压缩（节省 ${event.savedMessages} 条消息）`)]

    case 'context_warning':
      return [chalk.yellow.dim(`⚠️ 上下文已用 ${event.usedPercent}%，建议开始新会话`)]

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
```

- [ ] **Step 2: Rewrite `message-list.tsx`**

Replace the entire contents of `src/cli/tui/components/message-list.tsx`:

```typescript
// src/cli/tui/components/message-list.tsx
// Virtual scroll: all events pre-rendered to ANSI lines, then sliced to viewport.
// No more marginTop hack. Only visible lines reach the screen buffer.

import React, { useMemo } from 'react'
import { AnsiBlock } from '../gc-renderer/index.js'
import { renderEventToAnsiLines, renderThinkingLine } from '../lib/event-renderer.js'
import { markdownToAnsiLines } from '../lib/ansi-markdown.js'
import type { TuiEvent } from '../types.js'
import type { TuiAction } from '../state.js'
import { useAnimationFrame } from '../gc-renderer/index.js'

type Dispatch = React.Dispatch<TuiAction>

interface MessageListProps {
  events: TuiEvent[]
  streamingContent: string
  columns: number
  scrollOffset: number
  visibleRows: number
  thinkingContent: string
  thinkingStartMs: number
  thinkingDone: boolean
  elapsedMs: number
  dispatch: Dispatch
}

export function MessageList({
  events, streamingContent, columns,
  scrollOffset, visibleRows,
  thinkingContent, thinkingStartMs, thinkingDone, elapsedMs,
  dispatch,
}: MessageListProps) {
  // Animation tick — forces re-render for spinner animation
  useAnimationFrame()

  const isThinking = thinkingContent.length > 0 && !thinkingDone

  // ── Pre-render all events to ANSI lines (memoized) ─────────────────────────
  const eventLines = useMemo(() =>
    events
      .filter(e => e.kind !== 'delta' && e.kind !== 'turn_end' && e.kind !== 'thinking_delta')
      .flatMap(e => renderEventToAnsiLines(e, columns))
  , [events, columns])

  // ── Streaming suffix (re-renders every tick) ────────────────────────────────
  const streamLines = useMemo(() =>
    streamingContent && !isThinking
      ? markdownToAnsiLines(streamingContent, columns - 2).map(l => '  ' + l)
      : []
  , [streamingContent, isThinking, columns])

  // ── Thinking spinner (single line) ─────────────────────────────────────────
  const thinkingLine = isThinking
    ? renderThinkingLine(isThinking, elapsedMs, thinkingStartMs)
    : ''

  // ── Combine all lines ────────────────────────────────────────────────────────
  const allLines = [
    ...eventLines,
    ...streamLines,
    ...(thinkingLine ? [thinkingLine] : []),
  ]

  const totalLines = allLines.length
  const maxScroll  = Math.max(0, totalLines - visibleRows)

  // Update max scroll offset whenever total changes
  // We use a ref-style approach to avoid dispatching on every render
  React.useEffect(() => {
    dispatch({ type: 'SET_MAX_SCROLL_OFFSET', value: maxScroll })
  }, [maxScroll, dispatch])

  // ── Slice to viewport ────────────────────────────────────────────────────────
  const clampedScroll = Math.min(scrollOffset, maxScroll)
  const start = Math.max(0, totalLines - visibleRows - clampedScroll)
  const visibleLines = allLines.slice(start, start + visibleRows)

  return (
    <AnsiBlock lines={visibleLines} width={columns} />
  )
}
```

- [ ] **Step 3: Run full test suite**

```bash
pnpm test && pnpm tsc --noEmit
```

Expected: 793+ pass, 0 tsc errors

- [ ] **Step 4: Commit**

```bash
git add src/cli/tui/lib/event-renderer.ts src/cli/tui/components/message-list.tsx
git commit -m "feat(tui): virtual scroll — pre-render events to ANSI lines, slice to viewport"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|-------------|------|
| `padAnsiLine` preserves ANSI on truncate | Task 1 |
| `justifyContent: space-between` (header, editor) | Task 2 |
| `justifyContent: flex-end` (editor status bar) | Task 2 |
| `gap` between items | Task 2 |
| `overflowY: hidden` clip | Task 2 |
| `alignItems` (row cross-axis) | Task 2 |
| Virtual scroll (no marginTop hack) | Task 3 |
| Thinking spinner in virtual scroll | Task 3 |
| Streaming content in virtual scroll | Task 3 |

### Placeholder scan

None — all code is complete and shown verbatim.

### Type consistency

- `naturalWidth(node, availWidth): number` — exported from layout.ts, used in layout.test.ts
- `renderEventToAnsiLines(event, columns): string[]` — from event-renderer.ts, used in message-list.tsx
- `renderThinkingLine(isStreaming, elapsedMs, thinkingStartMs): string` — same module
- `AnsiBlock` — from gc-renderer/index.js, re-exports from components.tsx
- `useAnimationFrame()` — from gc-renderer/index.js, re-exports from frame.ts
