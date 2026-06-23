// DiffBlock — unified diff renderer with space-theme colors
// Parses standard unified diff format (git diff output, patch files).
// Integrated in:
//   - MessageBubble: via MD_COMPONENTS for ```diff code fences
//   - ToolCallCard: auto-detected from tool output

interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk' | 'header'
  content: string
  oldNo?: number
  newNo?: number
}

interface ParsedDiff {
  oldFile: string
  newFile: string
  added: number
  removed: number
  lines: DiffLine[]
}

export function parseDiff(text: string): ParsedDiff {
  const lines = text.split('\n')
  const result: DiffLine[] = []
  let oldFile = ''
  let newFile = ''
  let added = 0
  let removed = 0
  let oldNo = 0
  let newNo = 0

  for (const raw of lines) {
    if (raw.startsWith('--- ')) {
      oldFile = raw.slice(4).replace(/^[ab]\//, '')
      result.push({ type: 'header', content: raw })
    } else if (raw.startsWith('+++ ')) {
      newFile = raw.slice(4).replace(/^[ab]\//, '')
      result.push({ type: 'header', content: raw })
    } else if (raw.startsWith('@@ ')) {
      // @@ -l,n +l,n @@ optional context
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (m) { oldNo = Number(m[1]); newNo = Number(m[2]) }
      result.push({ type: 'hunk', content: raw })
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      result.push({ type: 'del', content: raw.slice(1), oldNo: oldNo++ })
      removed++
    } else if (raw.startsWith('+') && !raw.startsWith('+++')) {
      result.push({ type: 'add', content: raw.slice(1), newNo: newNo++ })
      added++
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — skip
    } else {
      result.push({ type: 'ctx', content: raw.startsWith(' ') ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ })
    }
  }

  return { oldFile, newFile, added, removed, lines: result }
}

// Detect if a string looks like a unified diff
export function isDiff(text: string): boolean {
  return /^(---|\+\+\+|@@|diff --git)/m.test(text)
}

const STYLES = {
  add: {
    background: 'rgba(0,212,255,0.10)',
    borderLeft: '3px solid var(--gc-accent2)',
  },
  del: {
    background: 'rgba(255,68,0,0.12)',
    borderLeft: '3px solid var(--gc-red)',
  },
  hunk: {
    background: 'var(--gc-panel-deep)',
    borderLeft: '3px solid var(--gc-border)',
  },
  header: {
    background: 'transparent',
    borderLeft: '3px solid transparent',
  },
  ctx: {
    background: 'transparent',
    borderLeft: '3px solid transparent',
  },
}

const SIGN: Record<DiffLine['type'], string> = {
  add: '+',
  del: '-',
  hunk: ' ',
  header: ' ',
  ctx: ' ',
}

const SIGN_COLOR: Record<DiffLine['type'], string> = {
  add: 'var(--gc-accent2)',
  del: 'var(--gc-red)',
  hunk: 'var(--gc-text-dim)',
  header: 'var(--gc-text-dim)',
  ctx: 'transparent',
}

const TEXT_COLOR: Record<DiffLine['type'], string> = {
  add: 'var(--gc-accent2)',
  del: 'var(--gc-red)',
  hunk: 'var(--gc-text-dim)',
  header: 'var(--gc-text-label)',
  ctx: 'var(--gc-assistant-text)',
}

function LineNo({ n }: { n?: number }) {
  return (
    <span style={{
      display: 'inline-block', width: 36, textAlign: 'right',
      color: 'var(--gc-text-label)', userSelect: 'none',
      fontSize: 10, paddingRight: 8, flexShrink: 0,
    }}>
      {n ?? ''}
    </span>
  )
}

export default function DiffBlock({ text, filename }: { text: string; filename?: string }) {
  const diff = parseDiff(text)
  const displayFile = filename ?? diff.newFile ?? diff.oldFile ?? ''

  const summary = diff.added === 0 && diff.removed === 0
    ? null
    : [
        diff.added > 0 ? `+${diff.added}` : null,
        diff.removed > 0 ? `-${diff.removed}` : null,
      ].filter(Boolean).join('  ')

  return (
    <div style={{
      margin: '8px 0',
      border: '1px solid var(--gc-border)',
      borderLeft: '2px solid var(--gc-accent2)',
      background: 'var(--gc-panel-deep)',
      overflow: 'hidden',
      fontFamily: "'Share Tech Mono', monospace",
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '4px 10px', borderBottom: '1px solid var(--gc-border)',
        background: 'var(--gc-assistant-bg)',
      }}>
        <span style={{ fontSize: 9, color: 'var(--gc-accent2-dim)', letterSpacing: '0.12em' }}>
          DIFF ▸ {displayFile || '(patch)'}
        </span>
        {summary && (
          <span style={{ fontSize: 9, letterSpacing: '0.1em' }}>
            {diff.added > 0 && (
              <span style={{ color: 'var(--gc-accent2)', marginRight: 8 }}>+{diff.added}</span>
            )}
            {diff.removed > 0 && (
              <span style={{ color: 'var(--gc-red)' }}>−{diff.removed}</span>
            )}
          </span>
        )}
      </div>

      {/* Lines */}
      <div style={{ overflowX: 'auto' }}>
        {diff.lines.filter(l => l.type !== 'header').map((line, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'baseline',
            ...STYLES[line.type],
            minHeight: 20,
          }}>
            {/* Old line no */}
            <LineNo n={line.type === 'del' || line.type === 'ctx' ? line.oldNo : undefined} />
            {/* New line no */}
            <LineNo n={line.type === 'add' || line.type === 'ctx' ? line.newNo : undefined} />
            {/* +/- sign */}
            <span style={{
              width: 14, flexShrink: 0, textAlign: 'center',
              color: SIGN_COLOR[line.type], userSelect: 'none', fontSize: 11,
            }}>
              {SIGN[line.type]}
            </span>
            {/* Content */}
            <span style={{
              flex: 1, fontSize: 12, color: TEXT_COLOR[line.type],
              whiteSpace: 'pre', padding: '1px 8px 1px 0',
              fontStyle: line.type === 'hunk' ? 'italic' : 'normal',
            }}>
              {line.content || ' '}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
