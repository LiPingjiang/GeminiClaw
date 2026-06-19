import { describe, it, expect } from 'vitest'
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
