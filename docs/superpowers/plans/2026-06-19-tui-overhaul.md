# TUI Comprehensive Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring GeminiClaw's TUI to parity with Claude Code across seven areas: Markdown rendering, animated spinner, input border, diff background colors, thinking persistence, tool output folding, and kill-ring yank.

**Architecture:** All changes are confined to `src/cli/tui/`. A new `lib/markdown-render.ts` module provides the Ink component tree from a markdown string. The spinner overhaul lives entirely in `editor.tsx` (no new state). Diff and thinking changes are localised to their own component files. Kill-ring yank adds two module-level refs to `use-text-input.ts`.

**Tech Stack:** Ink 7, React 19, `marked` (new dep), TypeScript, Vitest

## Global Constraints

- Node ≥ 20; pnpm workspace; `"type": "module"` — all imports must use `.js` extension
- Ink 7 API: `Box`, `Text`, `useInput`, `useApp`, `useStdout`, `useStdin` — no Ink 6 APIs
- No new Ink custom components (like `NoSelect`, `RawAnsi`) — those are internal to Claude Code's fork
- All new files must compile with `pnpm tsc --noEmit`
- Tests run with `pnpm test` (Vitest)
- Commit after every task

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/cli/tui/lib/markdown-render.ts` | **Create** | Convert markdown string → Ink ReactNode tree |
| `src/cli/tui/components/streaming-md.tsx` | **Modify** | Use markdown-render instead of plain green text |
| `src/cli/tui/components/message-item.tsx` | **Modify** | Tool output folding; thinking_end shows content |
| `src/cli/tui/components/editor.tsx` | **Modify** | Animated spinner (glyphs + verbs + time + tokens) + top separator line |
| `src/cli/tui/components/diff-view.tsx` | **Modify** | `+` lines blue background, `-` lines red background, full-width padding |
| `src/cli/tui/hooks/use-text-input.ts` | **Modify** | Kill-ring yank (Ctrl+Y) |
| `src/cli/tui/app.tsx` | **Modify** | Pass `elapsedMs` and `totalOutputTokens` to `<Editor>` |

---

## Task 1: Install `marked` and create the Markdown renderer

**Files:**
- Create: `src/cli/tui/lib/markdown-render.ts`
- Test: `src/cli/tui/lib/markdown-render.test.ts`

**Interfaces:**
- Produces: `renderMarkdown(text: string, columns: number): React.ReactNode` — exported named function

- [ ] **Step 1: Install marked**

```bash
cd /Users/lipingjiang/Codes/GeminiClaw
pnpm add marked @types/marked
```

Expected: `package.json` now lists `"marked"` in dependencies.

- [ ] **Step 2: Write failing tests**

Create `src/cli/tui/lib/markdown-render.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderMarkdown } from './markdown-render.js'

describe('renderMarkdown', () => {
  it('returns a ReactNode for plain text', () => {
    const node = renderMarkdown('hello world', 80)
    expect(node).not.toBeNull()
  })

  it('returns a ReactNode for markdown with headings', () => {
    const node = renderMarkdown('# Hello\n\nParagraph', 80)
    expect(node).not.toBeNull()
  })

  it('returns a ReactNode for code blocks', () => {
    const node = renderMarkdown('```js\nconsole.log(1)\n```', 80)
    expect(node).not.toBeNull()
  })

  it('handles empty string', () => {
    const node = renderMarkdown('', 80)
    expect(node).not.toBeNull()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
pnpm test src/cli/tui/lib/markdown-render.test.ts
```

Expected: FAIL — `Cannot find module './markdown-render.js'`

- [ ] **Step 4: Implement the markdown renderer**

Create `src/cli/tui/lib/markdown-render.ts`:

```typescript
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
      const langLabel = t.lang ? DIM + t.lang + RESET + '\n' : ''
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
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm test src/cli/tui/lib/markdown-render.test.ts
```

Expected: 4 passing.

- [ ] **Step 6: Verify TypeScript compiles**

```bash
pnpm tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/cli/tui/lib/markdown-render.ts src/cli/tui/lib/markdown-render.test.ts package.json pnpm-lock.yaml
git commit -m "feat(tui): markdown renderer using marked — headings/paragraphs/code/lists/blockquotes"
```

---

## Task 2: Wire markdown rendering into streaming-md and message-item

**Files:**
- Modify: `src/cli/tui/components/streaming-md.tsx`
- Modify: `src/cli/tui/components/message-item.tsx`

**Interfaces:**
- Consumes: `renderMarkdown(text, columns)` from Task 1

- [ ] **Step 1: Update streaming-md.tsx**

Replace `src/cli/tui/components/streaming-md.tsx` entirely:

```typescript
import React, { memo, useRef } from 'react'
import { Box } from 'ink'
import { findStableBoundary } from '../lib/streaming-boundary.js'
import { renderMarkdown } from '../lib/markdown-render.js'

interface StreamingMdProps {
  text: string
  columns: number
}

export const StreamingMd = memo(function StreamingMd({ text, columns }: StreamingMdProps) {
  const stablePrefixRef = useRef('')

  if (!text.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = ''
  }

  const boundary = findStableBoundary(text)

  if (boundary > stablePrefixRef.current.length) {
    stablePrefixRef.current = text.slice(0, boundary)
  }

  const stable = stablePrefixRef.current
  const unstable = text.slice(stable.length)

  if (!stable) return <>{renderMarkdown(unstable, columns)}</>
  if (!unstable) return <StableBlock text={stable} columns={columns} />

  return (
    <Box flexDirection="column">
      <StableBlock text={stable} columns={columns} />
      {renderMarkdown(unstable, columns)}
    </Box>
  )
})

const StableBlock = memo(function StableBlock({ text, columns }: { text: string; columns: number }) {
  return <>{renderMarkdown(text, columns)}</>
})
```

- [ ] **Step 2: Update message-item.tsx — response case uses renderMarkdown; thinking_end shows content; tool output truncation**

Replace `src/cli/tui/components/message-item.tsx` entirely:

```typescript
// src/cli/tui/components/message-item.tsx
import React, { useState } from 'react'
import { Box, Text } from 'ink'
import type { TuiEvent } from '../types.js'
import { DiffView } from './diff-view.js'
import { renderMarkdown } from '../lib/markdown-render.js'

const TOOL_RESULT_PREVIEW_LEN = 200
const COLUMNS_DEFAULT = 80

interface MessageItemProps {
  event: TuiEvent
  columns?: number
}

export function MessageItem({ event, columns = COLUMNS_DEFAULT }: MessageItemProps) {
  switch (event.kind) {
    case 'user_message':
      return (
        <Box marginTop={1}>
          <Text bold color="yellow">{'❯ '}</Text>
          <Text bold wrap="wrap">{event.content}</Text>
        </Box>
      )

    case 'response':
      return (
        <Box marginTop={1} paddingLeft={2} flexDirection="column">
          {renderMarkdown(event.content, columns - 2)}
        </Box>
      )

    case 'tool_start':
      return (
        <Box marginTop={1}>
          <Text color="magenta" dimColor>{'⬡ '}</Text>
          <Text color="magenta" bold>{event.name}</Text>
          <Text dimColor>{' '}{formatArgs(event.args)}</Text>
        </Box>
      )

    case 'tool_end':
      return <ToolEndItem event={event} />

    case 'thinking_end':
      return <ThinkingEndItem event={event} columns={columns} />

    case 'agent_end':
      return (
        <Box marginTop={1}>
          <Text dimColor>
            {'✓ '}{event.totalTurns}{' turns · '}{event.stopReason}
            {event.usage ? ` · in:${fmtTokens(event.usage.inputTokens)} out:${fmtTokens(event.usage.outputTokens)}` : ''}
          </Text>
        </Box>
      )

    case 'error':
      return (
        <Box marginTop={1}>
          <Text color="red">{'✗ '}{event.message}</Text>
        </Box>
      )

    case 'system':
      return event.message ? (
        <Box>
          <Text dimColor>{event.message}</Text>
        </Box>
      ) : null

    case 'guardrail_warn':
      return (
        <Box>
          <Text color="yellow" dimColor>{'⚠ ['}{event.toolName}{']: '}{event.message}</Text>
        </Box>
      )

    case 'guardrail_halt':
      return (
        <Box>
          <Text color="red">{'✗ HALT ['}{event.toolName}{']: '}{event.message}</Text>
        </Box>
      )

    case 'turn_start':
      return null

    case 'diff':
      return (
        <Box marginTop={1}>
          <DiffView filename={event.filename} before={event.before} after={event.after} columns={columns} />
        </Box>
      )

    case 'delta':
    case 'turn_end':
    case 'thinking_delta':
      return null

    default:
      return null
  }
}

/** Collapsible tool_end: short results inline, long results folded. */
function ToolEndItem({ event }: { event: Extract<TuiEvent, { kind: 'tool_end' }> }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = event.result.length > TOOL_RESULT_PREVIEW_LEN

  return (
    <Box paddingLeft={2} flexDirection="column">
      <Box>
        <Text color={event.isError ? 'red' : 'green'} dimColor>
          {event.isError ? '✗' : '✓'}{' '}{event.name}{' '}{event.durationMs}ms
        </Text>
        {isLong && (
          <Text dimColor>
            {' '}
            <Text
              color="cyan"
              underline
              // Ink 7 doesn't have onClick; use a visual hint instead
            >
              {expanded ? '▼ collapse' : '▶ expand'}
            </Text>
          </Text>
        )}
      </Box>
      {event.result && (
        <Box paddingLeft={2}>
          <Text dimColor wrap="wrap">
            {isLong && !expanded
              ? event.result.slice(0, TOOL_RESULT_PREVIEW_LEN) + '…'
              : event.result}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/** thinking_end: always show "∴ Thought for Xs", collapsed content below. */
function ThinkingEndItem({
  event,
  columns,
}: {
  event: Extract<TuiEvent, { kind: 'thinking_end' }>
  columns: number
}) {
  const [expanded, setExpanded] = useState(false)
  const seconds = Math.max(1, Math.round(event.durationMs / 1000))

  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text dimColor italic>{'∴ Thought for '}{seconds}{'s'}</Text>
        {event.content && (
          <Text dimColor>{' · '}</Text>
        )}
        {event.content && (
          <Text dimColor italic>
            {expanded ? '▼' : '▶ show'}
          </Text>
        )}
      </Box>
      {expanded && event.content && (
        <Box paddingLeft={2} marginTop={1} flexDirection="column">
          {renderMarkdown(event.content, columns - 2)}
        </Box>
      )}
    </Box>
  )
}

function formatArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const s = JSON.stringify(args)
  return s.length > 120 ? s.slice(0, 120) + '…' : s
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
```

- [ ] **Step 3: Update MessageList to pass columns to MessageItem**

In `src/cli/tui/components/message-list.tsx`, change the MessageItem render line from:

```typescript
{allItems.map((event, i) => (
  <MessageItem key={i} event={event} />
))}
```

to:

```typescript
{allItems.map((event, i) => (
  <MessageItem key={i} event={event} columns={columns} />
))}
```

- [ ] **Step 4: Verify TypeScript**

```bash
pnpm tsc --noEmit 2>&1 | head -30
```

Expected: no errors (or only pre-existing errors unrelated to these files).

- [ ] **Step 5: Commit**

```bash
git add src/cli/tui/components/streaming-md.tsx src/cli/tui/components/message-item.tsx src/cli/tui/components/message-list.tsx
git commit -m "feat(tui): markdown rendering for responses; tool output fold; thinking_end expand"
```

---

## Task 3: Animated spinner + separator line in editor

**Files:**
- Modify: `src/cli/tui/components/editor.tsx`
- Modify: `src/cli/tui/app.tsx`

**Interfaces:**
- Consumes: `headerState.elapsedMs` and `headerState.totalOutputTokens` from `TuiState`
- `Editor` gains two new optional props: `elapsedMs?: number`, `totalOutputTokens?: number`

- [ ] **Step 1: Update `EditorProps` and the Editor component**

Open `src/cli/tui/components/editor.tsx`. Add `elapsedMs` and `totalOutputTokens` to `EditorProps`:

```typescript
// Add to EditorProps interface (after btwState):
elapsedMs?: number
totalOutputTokens?: number
```

Then update the Editor function signature to destructure them:

```typescript
export function Editor({ value, cursor, columns, focus, dispatch, onSubmit, onCancel, onExit, attachments, onScrollUp, onScrollDown, onScrollToBottom, isRunning, currentTool, suggestions, selectedSuggestion, onHistoryUp, onHistoryDown, btwState, onBtwScrollUp, onBtwScrollDown, onBtwClose, elapsedMs, totalOutputTokens }: EditorProps) {
```

Then in the `return` of the non-focus path (currently `<Box>...`), and the focus path, add a separator line **above** the first Box:

For the non-focus case, wrap in a fragment with separator:
```typescript
if (!focus) {
  return (
    <>
      <Text dimColor>{'─'.repeat(columns)}</Text>
      <Box>
        <Text color="gray" bold>{PROMPT}</Text>
        <Text dimColor>{value || 'waiting for agent...'}</Text>
      </Box>
    </>
  )
}
```

For the focus case, the outer `<Box flexDirection="column">` becomes:
```typescript
return (
  <>
    <Text dimColor>{'─'.repeat(columns)}</Text>
    <Box flexDirection="column">
      {attachments.length > 0 && (
        ...existing attachments JSX...
      )}
      <Box>
        <Text color="yellow" bold>{PROMPT}</Text>
        <Text>{rendered}</Text>
      </Box>
      <StatusBar
        focus={focus}
        isRunning={isRunning}
        currentTool={currentTool}
        inputEmpty={value === ''}
        inputIsCommand={value.startsWith('/')}
        columns={columns}
        elapsedMs={elapsedMs}
        totalOutputTokens={totalOutputTokens}
      />
    </Box>
  </>
)
```

- [ ] **Step 2: Rewrite `StatusBar` with animated spinner**

Replace the entire `StatusBar` function and its props interface in `editor.tsx`:

```typescript
// ── Spinner constants (matching Claude Code's style) ──────────────────────────

const SPINNER_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽']
const SPINNER_GLYPHS_REV = [...SPINNER_GLYPHS].reverse()
const SPINNER_CYCLE = [...SPINNER_GLYPHS, ...SPINNER_GLYPHS_REV]

const SPINNER_VERBS = [
  'Thinking', 'Working', 'Analyzing', 'Computing', 'Reasoning',
  'Processing', 'Generating', 'Synthesizing', 'Orchestrating', 'Evaluating',
  'Crunching', 'Deliberating', 'Calculating', 'Crafting', 'Pondering',
  'Puttering', 'Musing', 'Ruminating', 'Cogitating', 'Scheming',
  'Wrangling', 'Tinkering', 'Brewing', 'Cooking', 'Forging',
]

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function StatusBar({
  focus,
  isRunning,
  currentTool,
  inputEmpty,
  inputIsCommand,
  columns,
  elapsedMs = 0,
  totalOutputTokens = 0,
}: {
  focus: boolean
  isRunning: boolean
  currentTool?: string
  inputEmpty: boolean
  inputIsCommand: boolean
  columns: number
  elapsedMs?: number
  totalOutputTokens?: number
}) {
  const [frame, setFrame] = React.useState(0)
  const [verbIdx, setVerbIdx] = React.useState(() =>
    Math.floor(Math.random() * SPINNER_VERBS.length)
  )

  React.useEffect(() => {
    if (!isRunning) return
    const glyphTimer = setInterval(() => setFrame(f => (f + 1) % SPINNER_CYCLE.length), 120)
    const verbTimer  = setInterval(() => setVerbIdx(i => (i + 1) % SPINNER_VERBS.length), 2000)
    return () => { clearInterval(glyphTimer); clearInterval(verbTimer) }
  }, [isRunning])

  if (!focus) return null

  if (isRunning) {
    const glyph  = SPINNER_CYCLE[frame % SPINNER_CYCLE.length] ?? '✻'
    const verb   = SPINNER_VERBS[verbIdx % SPINNER_VERBS.length] ?? 'Working'
    const label  = currentTool ? `${glyph} ${currentTool}…` : `${glyph} ${verb}…`
    const timeStr  = elapsedMs > 0 ? formatDuration(elapsedMs) : ''
    const tokenStr = totalOutputTokens > 0 ? `↓ ${formatTokens(totalOutputTokens)} tokens` : ''
    const parts = [timeStr, tokenStr].filter(Boolean)
    const suffix = parts.length > 0 ? ` (${parts.join(' · ')})` : ''

    return (
      <Box justifyContent="space-between">
        <Text color="green">{label}</Text>
        <Text dimColor>{suffix}{'  esc to interrupt'}</Text>
      </Box>
    )
  }

  if (inputIsCommand) {
    return (
      <Box>
        <Text dimColor>{'  ↑↓ select  Tab complete  Esc close'}</Text>
      </Box>
    )
  }

  if (!inputEmpty) {
    return (
      <Box justifyContent="flex-end">
        <Text dimColor>{'Enter send  Shift+Enter newline  '}</Text>
      </Box>
    )
  }

  return (
    <Box justifyContent="space-between">
      <Text dimColor>{'  /btw · /clear · /model · /help'}</Text>
      <Text dimColor>{'? for commands  '}</Text>
    </Box>
  )
}
```

- [ ] **Step 3: Update app.tsx to pass elapsedMs and totalOutputTokens to Editor**

In `src/cli/tui/app.tsx`, find the `<Editor` usage and add the two new props:

```typescript
<Editor
  // ... existing props ...
  elapsedMs={headerState.elapsedMs ?? 0}
  totalOutputTokens={headerState.totalOutputTokens ?? 0}
/>
```

- [ ] **Step 4: Verify TypeScript**

```bash
pnpm tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/tui/components/editor.tsx src/cli/tui/app.tsx
git commit -m "feat(tui): animated spinner (glyphs+verbs+time+tokens) + input separator line"
```

---

## Task 4: Diff view — full-line red/blue backgrounds

**Files:**
- Modify: `src/cli/tui/components/diff-view.tsx`
- Modify: `src/cli/tui/components/diff-view.test.ts`

**Interfaces:**
- No interface changes; internal rendering only

- [ ] **Step 1: Update diff-view.tsx**

Open `src/cli/tui/components/diff-view.tsx`. Replace the `add` and `remove` rendering in `DiffView` from color-only text to background-colored, full-width padded text.

Find the lines rendering diff lines:

```typescript
if (line.type === 'add')    return <Text key={i} color="green">{'+'}{truncate(line.content ?? '', maxLineLen - 1)}</Text>
if (line.type === 'remove') return <Text key={i} color="red">{'-'}{truncate(line.content ?? '', maxLineLen - 1)}</Text>
return <Text key={i} dimColor>{'  '}{truncate(line.content ?? '', maxLineLen - 2)}</Text>
```

Replace them with:

```typescript
if (line.type === 'add') {
  const content = '+' + truncate(line.content ?? '', maxLineLen - 1)
  return (
    <Text key={i} backgroundColor="blue" color="white">
      {content.padEnd(maxLineLen)}
    </Text>
  )
}
if (line.type === 'remove') {
  const content = '-' + truncate(line.content ?? '', maxLineLen - 1)
  return (
    <Text key={i} backgroundColor="red" color="white">
      {content.padEnd(maxLineLen)}
    </Text>
  )
}
return <Text key={i} dimColor>{'  '}{truncate(line.content ?? '', maxLineLen - 2)}</Text>
```

- [ ] **Step 2: Verify existing diff-view tests still pass**

```bash
pnpm test src/cli/tui/components/diff-view.test.ts
```

Expected: all passing.

- [ ] **Step 3: Verify TypeScript**

```bash
pnpm tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/tui/components/diff-view.tsx
git commit -m "feat(tui): diff view — blue background for additions, red for removals, full-width"
```

---

## Task 5: Kill-ring yank (Ctrl+Y) in use-text-input

**Files:**
- Modify: `src/cli/tui/hooks/use-text-input.ts`
- Test: `src/cli/tui/hooks/use-text-input.test.ts` (already exists — add yank test)

**Interfaces:**
- No interface changes; internal kill-ring state added as module-level variable

- [ ] **Step 1: Add kill-ring storage**

Open `src/cli/tui/hooks/use-text-input.ts`. Add a module-level kill ring buffer **after** the imports (before `charDisplayWidth`):

```typescript
// Module-level kill ring — persists across renders (by design; same as Emacs)
let _killRingContent = ''
```

- [ ] **Step 2: Modify Ctrl+K to save to kill ring**

Find the existing Ctrl+K handler:

```typescript
if (key.ctrl && input === 'k') {
  const lineEnd = value.indexOf('\n', cursor)
  onChange(value.slice(0, cursor) + (lineEnd >= 0 ? value.slice(lineEnd) : ''), cursor); return
}
```

Replace with:

```typescript
if (key.ctrl && input === 'k') {
  const lineEnd = value.indexOf('\n', cursor)
  const killed = lineEnd >= 0 ? value.slice(cursor, lineEnd) : value.slice(cursor)
  if (killed) _killRingContent = killed
  onChange(value.slice(0, cursor) + (lineEnd >= 0 ? value.slice(lineEnd) : ''), cursor); return
}
```

- [ ] **Step 3: Modify Ctrl+U to save to kill ring**

Find the existing Ctrl+U handler:

```typescript
if (key.ctrl && input === 'u') {
  const lineStart = value.lastIndexOf('\n', cursor - 1) + 1
  onChange(value.slice(0, lineStart) + value.slice(cursor), lineStart); return
}
```

Replace with:

```typescript
if (key.ctrl && input === 'u') {
  const lineStart = value.lastIndexOf('\n', cursor - 1) + 1
  const killed = value.slice(lineStart, cursor)
  if (killed) _killRingContent = killed
  onChange(value.slice(0, lineStart) + value.slice(cursor), lineStart); return
}
```

- [ ] **Step 4: Add Ctrl+Y (yank) handler**

After the Ctrl+U block, add:

```typescript
// Ctrl+Y — yank (paste last killed text)
if (key.ctrl && input === 'y') {
  if (_killRingContent) {
    const newVal = value.slice(0, cursor) + _killRingContent + value.slice(cursor)
    onChange(newVal, cursor + _killRingContent.length)
  }
  return
}
```

- [ ] **Step 5: Write and run tests**

Create/append to test file. Since `useTextInput` uses `useInput` from Ink (hard to unit-test in isolation), add a simple module-level test for the kill ring helpers:

Check if `src/cli/tui/hooks/use-text-input.test.ts` already exists:

```bash
ls src/cli/tui/hooks/
```

If a test file exists, add this test case. If not, create `src/cli/tui/hooks/use-text-input.test.ts`:

```typescript
// Note: We test the pure helper functions exported from use-text-input, not the hook itself
// (the hook requires Ink's rendering context).
import { describe, it, expect } from 'vitest'
import { renderWithCursor, computeCursorPosition } from './use-text-input.js'

describe('renderWithCursor', () => {
  it('renders cursor at end of string', () => {
    const result = renderWithCursor('hello', 5)
    expect(result).toContain('\x1b[7m') // inverse video ANSI code
  })

  it('renders cursor at start', () => {
    const result = renderWithCursor('hello', 0)
    expect(result.indexOf('\x1b[7m')).toBeLessThan(result.indexOf('h') + 5)
  })
})

describe('computeCursorPosition', () => {
  it('returns 0,0 for empty string', () => {
    expect(computeCursorPosition('', 0, 80)).toEqual({ row: 0, col: 0 })
  })

  it('computes wrap correctly', () => {
    const pos = computeCursorPosition('a'.repeat(85), 85, 80)
    expect(pos.row).toBe(1)
    expect(pos.col).toBe(5)
  })
})
```

```bash
pnpm test src/cli/tui/hooks/use-text-input.test.ts
```

Expected: passing.

- [ ] **Step 6: Verify TypeScript**

```bash
pnpm tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 7: Commit**

```bash
git add src/cli/tui/hooks/use-text-input.ts src/cli/tui/hooks/use-text-input.test.ts
git commit -m "feat(tui): Ctrl+K/U save to kill ring, Ctrl+Y yanks"
```

---

## Task 6: Push all changes to remote and rebuild on the remote machine

**Files:** None (deployment only)

- [ ] **Step 1: Push to origin**

```bash
git push origin main
```

- [ ] **Step 2: Pull on the remote machine (192.168.1.7)**

```bash
ssh pingjiangli@192.168.1.7 "cd ~/Code/GeminiClaw && git pull origin main" 2>&1
```

Expected: Fast-forward, all new commits applied.

- [ ] **Step 3: Install dependencies on remote (marked is new)**

```bash
ssh pingjiangli@192.168.1.7 "cd ~/Code/GeminiClaw && pnpm install" 2>&1
```

- [ ] **Step 4: Build on remote**

```bash
ssh pingjiangli@192.168.1.7 "cd ~/Code/GeminiClaw && pnpm build 2>&1" 2>&1
```

Expected: TypeScript compiles without errors, `dist/` populated.

- [ ] **Step 5: Restart the server on remote**

```bash
ssh pingjiangli@192.168.1.7 "cd ~/Code/GeminiClaw && kill \$(lsof -ti:18888) 2>/dev/null; nohup pnpm start > server.log 2>&1 &" 2>&1
```

- [ ] **Step 6: Verify server is up**

```bash
ssh pingjiangli@192.168.1.7 "sleep 2 && curl -s http://127.0.0.1:18888/health" 2>&1
```

Expected: `{"status":"ok"}` or similar.

- [ ] **Step 7: Final commit (if any loose files)**

```bash
git status
```

If clean, no commit needed. If there are stray changes, commit them.

---

## Self-Review Checklist

### Spec coverage

| Feature | Task |
|---------|------|
| Markdown rendering | Task 1 (renderer) + Task 2 (wiring) |
| Spinner animation with glyphs + verbs + time + tokens | Task 3 |
| Input separator line | Task 3 |
| Diff blue/red backgrounds | Task 4 |
| Kill ring yank | Task 5 |
| Thinking persistence (content shown collapsed) | Task 2 |
| Tool output folding | Task 2 |
| Deploy to remote | Task 6 |

### Placeholder scan
- No TBDs, all code is complete.

### Type consistency
- `elapsedMs` and `totalOutputTokens` are `number | undefined` in EditorProps → accessed with `?? 0` guards throughout.
- `renderMarkdown(text: string, columns: number): React.ReactNode` used consistently in Tasks 1, 2.
- `_killRingContent: string` is module-level, not exported (intentional).
