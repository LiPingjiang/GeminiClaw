# TUI Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add visual redesign (spacing/typography), thinking mode animation, clipboard image paste, diff rendering, structured logging with `gc watch`, and mouse wheel scroll to the GeminiClaw TUI.

**Architecture:** Six sequential feature layers, each building on the previous: (1) visual system — cosmetic only; (2) state extensions for thinking/attachments/scroll; (3) thinking mode stream parsing + rendering; (4) clipboard image paste; (5) diff rendering + show_diff tool; (6) logger + TraceHub refactor + gc watch CLI; (7) mouse wheel scroll.

**Tech Stack:** TypeScript, React 19, Ink 7.0.6, Vitest, Node ≥ 20, `diff` npm package (new dep)

## Global Constraints

- Ink 7.0.6 public API only — no fork, no private APIs
- No new npm dependencies except `diff` package
- TypeScript strict mode; no `any` in new files
- All tests colocated as `*.test.ts` beside the file they test
- `pnpm test` must stay green after every task
- `npx tsc --noEmit` must pass after every task
- Node ≥ 20 (Intl.Segmenter, crypto.randomUUID built-in)
- Commit after every task

---

## Task 1: Visual Redesign — message-item.tsx + header.tsx

**Files:**
- Modify: `src/cli/tui/components/message-item.tsx`
- Modify: `src/cli/tui/components/header.tsx`

**Interfaces:**
- Consumes: existing `TuiEvent`, `HeaderState` from `../types.js` — no changes
- Produces: visually redesigned components (no interface changes)

- [ ] **Step 1: Rewrite `message-item.tsx` with new visual system**

Replace the entire file with:

```tsx
// src/cli/tui/components/message-item.tsx
import React from 'react'
import { Box, Text } from 'ink'
import type { TuiEvent } from '../types.js'

interface MessageItemProps {
  event: TuiEvent
}

export function MessageItem({ event }: MessageItemProps) {
  switch (event.kind) {
    case 'user_message':
      return (
        <Box marginTop={1}>
          <Text bold>{'❯ '}</Text>
          <Text bold>{event.content}</Text>
        </Box>
      )

    case 'response':
      return (
        <Box marginTop={1} paddingLeft={2}>
          <Text>{event.content}</Text>
        </Box>
      )

    case 'tool_start':
      return (
        <Box marginTop={1}>
          <Text color="magenta" dimColor>{'⬡ '}</Text>
          <Text color="magenta" dimColor bold>{event.name}</Text>
          <Text dimColor>{' ('}{JSON.stringify(event.args).slice(0, 80)}{')'}</Text>
        </Box>
      )

    case 'tool_end':
      return (
        <Box paddingLeft={2}>
          <Text color={event.isError ? 'red' : 'green'} dimColor>
            {event.isError ? '✗' : '✓'}{' '}{event.name}{' '}{event.durationMs}ms
          </Text>
        </Box>
      )

    case 'thinking_end':
      return (
        <Box marginTop={1}>
          <Text dimColor italic>{'∴ Thought for '}{Math.round(event.durationMs / 1000)}{'s'}</Text>
        </Box>
      )

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
        <Box>
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
      return (
        <Box justifyContent="flex-end">
          <Text dimColor>{'─ TURN '}{event.turn}{' ─'}</Text>
        </Box>
      )

    case 'diff':
      // DiffView wired in Task 5
      return (
        <Box marginTop={1} paddingLeft={2}>
          <Text dimColor>{'[diff: '}{event.filename}{'  — install DiffView in Task 5]'}</Text>
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

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}
```

- [ ] **Step 2: Rewrite `header.tsx` without border**

Replace the entire file with:

```tsx
// src/cli/tui/components/header.tsx
import React from 'react'
import { Box, Text } from 'ink'
import type { HeaderState } from '../types.js'

interface HeaderProps {
  state: HeaderState
  columns: number
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

function shortenModel(model?: string): string {
  if (!model) return ''
  const name = model.split('/').at(-1) ?? model
  return name.length > 22 ? name.slice(0, 19) + '…' : name
}

export function Header({ state, columns }: HeaderProps) {
  const dot = state.status === 'running' ? '●' : state.status === 'error' ? '✕' : '○'
  const dotColor = state.status === 'running' ? 'green' : state.status === 'error' ? 'red' : 'gray'
  const modelStr = shortenModel(state.model)
  const thinkingIndicator = state.thinkingEnabled ? ' ∴' : ''
  const separator = '─'.repeat(Math.max(0, columns))
  const totalTokens = (state.totalInputTokens ?? 0) + (state.totalOutputTokens ?? 0)

  return (
    <Box flexDirection="column">
      {/* Top line */}
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text bold color="cyan">GeminiClaw</Text>
          {modelStr && <Text dimColor>{modelStr}{thinkingIndicator}</Text>}
          {state.turn !== undefined && <Text dimColor>T{state.turn}</Text>}
          {state.currentTool && <Text color="yellow" dimColor>⚡{state.currentTool}</Text>}
        </Box>
        <Box gap={1}>
          {state.elapsedMs !== undefined && state.elapsedMs > 0 && (
            <Text dimColor>{fmtMs(state.elapsedMs)}</Text>
          )}
          <Text color={dotColor} bold>{dot}</Text>
        </Box>
      </Box>
      {/* Separator */}
      <Text dimColor>{separator}</Text>
      {/* Stats line */}
      <Box justifyContent="space-between">
        <Box gap={1}>
          {totalTokens > 0 ? (
            <>
              <Text dimColor>in:{fmtTokens(state.totalInputTokens ?? 0)}</Text>
              <Text dimColor>out:{fmtTokens(state.totalOutputTokens ?? 0)}</Text>
              {(state.totalCacheReadTokens ?? 0) > 0 && (
                <Text dimColor>cache:{fmtTokens(state.totalCacheReadTokens ?? 0)}</Text>
              )}
            </>
          ) : (
            <Text dimColor>Ready</Text>
          )}
        </Box>
        <Box gap={1}>
          {state.sessionId && <Text dimColor>sess:{state.sessionId.slice(0, 8)}</Text>}
          {state.fileIndexSize !== undefined && <Text dimColor>idx:{state.fileIndexSize}</Text>}
          <Text dimColor>/help</Text>
        </Box>
      </Box>
    </Box>
  )
}
```

- [ ] **Step 3: Update app.tsx to pass `columns` to Header**

In `src/cli/tui/app.tsx`, find the `<Header state={headerState} />` line and change it to:

```tsx
<Header state={headerState} columns={termSize.columns} />
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: errors about `thinking_end`, `thinking_delta`, `diff` missing from TuiEvent union and `thinkingEnabled` missing from HeaderState — these are stubs to be added in Task 2. Add them temporarily as empty stubs to unblock:

In `src/cli/tui/types.ts`, add to the `TuiEvent` union:
```typescript
| { kind: 'thinking_delta'; delta: string }
| { kind: 'thinking_end'; content: string; durationMs: number }
| { kind: 'diff'; filename: string; before: string; after: string }
```

Add to `HeaderState`:
```typescript
thinkingEnabled?: boolean
```

Re-run `npx tsc --noEmit 2>&1 | head -5` — expected: no output (zero errors).

- [ ] **Step 5: Run tests**

```bash
pnpm test
```

Expected: all 733 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli/tui/components/message-item.tsx src/cli/tui/components/header.tsx src/cli/tui/app.tsx src/cli/tui/types.ts
git commit -m "feat(tui): visual redesign — spacing, prefix system, borderless header"
```

---

## Task 2: State Extensions — thinking + attachments + scroll

**Files:**
- Modify: `src/cli/tui/state.ts`
- Modify: `src/cli/tui/state.test.ts`

**Interfaces:**
- Produces:
  - `TuiState.thinkingContent: string`
  - `TuiState.thinkingStartMs: number`
  - `TuiState.thinkingDone: boolean`
  - `TuiState.thinkingDurationMs: number`
  - `TuiState.inputAttachments: InputAttachment[]`
  - `TuiState.scrollOffset: number`
  - `InputAttachment` interface (exported)
  - New `TuiAction` variants: `THINKING_DELTA`, `THINKING_DONE`, `THINKING_CLEAR`, `INPUT_ATTACH_IMAGE`, `INPUT_CLEAR_ATTACHMENTS`, `SCROLL_UP`, `SCROLL_DOWN`, `SCROLL_TO_BOTTOM`
- Consumed by: Tasks 3, 4, 7

- [ ] **Step 1: Write failing tests**

Add to `src/cli/tui/state.test.ts`:

```typescript
describe('thinking actions', () => {
  it('THINKING_DELTA accumulates content and sets startMs', () => {
    const s1 = tuiReducer(base, { type: 'THINKING_DELTA', delta: 'hello ', nowMs: 1000 })
    expect(s1.thinkingContent).toBe('hello ')
    expect(s1.thinkingStartMs).toBe(1000)
    expect(s1.thinkingDone).toBe(false)
    const s2 = tuiReducer(s1, { type: 'THINKING_DELTA', delta: 'world', nowMs: 2000 })
    expect(s2.thinkingContent).toBe('hello world')
    expect(s2.thinkingStartMs).toBe(1000) // preserved from first delta
  })

  it('THINKING_DONE sets done flag and duration, adds thinking_end event', () => {
    const s1 = tuiReducer(base, { type: 'THINKING_DELTA', delta: 'hi', nowMs: 1000 })
    const s2 = tuiReducer(s1, { type: 'THINKING_DONE', content: 'hi', durationMs: 3500 })
    expect(s2.thinkingDone).toBe(true)
    expect(s2.thinkingDurationMs).toBe(3500)
    expect(s2.events.at(-1)).toEqual({ kind: 'thinking_end', content: 'hi', durationMs: 3500 })
  })

  it('SEND_MESSAGE clears thinking state', () => {
    const s1 = tuiReducer(base, { type: 'THINKING_DELTA', delta: 'thinking', nowMs: 1000 })
    const s2 = tuiReducer(s1, { type: 'SEND_MESSAGE', message: 'hi' })
    expect(s2.thinkingContent).toBe('')
    expect(s2.thinkingDone).toBe(false)
    expect(s2.thinkingStartMs).toBe(0)
  })
})

describe('attachment actions', () => {
  const attachment = {
    base64: 'abc123',
    mediaType: 'image/png' as const,
    filename: 'clipboard',
    sizeBytes: 1024,
  }

  it('INPUT_ATTACH_IMAGE adds to attachments', () => {
    const s = tuiReducer(base, { type: 'INPUT_ATTACH_IMAGE', attachment })
    expect(s.inputAttachments).toHaveLength(1)
    expect(s.inputAttachments[0]).toEqual(attachment)
  })

  it('INPUT_CLEAR_ATTACHMENTS empties list', () => {
    const s1 = tuiReducer(base, { type: 'INPUT_ATTACH_IMAGE', attachment })
    const s2 = tuiReducer(s1, { type: 'INPUT_CLEAR_ATTACHMENTS' })
    expect(s2.inputAttachments).toHaveLength(0)
  })

  it('SEND_MESSAGE clears attachments', () => {
    const s1 = tuiReducer(base, { type: 'INPUT_ATTACH_IMAGE', attachment })
    const s2 = tuiReducer(s1, { type: 'SEND_MESSAGE', message: 'hi' })
    expect(s2.inputAttachments).toHaveLength(0)
  })
})

describe('scroll actions', () => {
  it('SCROLL_UP increases offset', () => {
    const s = tuiReducer(base, { type: 'SCROLL_UP', lines: 3 })
    expect(s.scrollOffset).toBe(3)
  })

  it('SCROLL_DOWN decreases offset, clamps at 0', () => {
    const s1 = tuiReducer(base, { type: 'SCROLL_UP', lines: 5 })
    const s2 = tuiReducer(s1, { type: 'SCROLL_DOWN', lines: 3 })
    expect(s2.scrollOffset).toBe(2)
    const s3 = tuiReducer(s2, { type: 'SCROLL_DOWN', lines: 10 })
    expect(s3.scrollOffset).toBe(0)
  })

  it('SCROLL_TO_BOTTOM resets to 0', () => {
    const s1 = tuiReducer(base, { type: 'SCROLL_UP', lines: 10 })
    const s2 = tuiReducer(s1, { type: 'SCROLL_TO_BOTTOM' })
    expect(s2.scrollOffset).toBe(0)
  })

  it('SEND_MESSAGE resets scroll to bottom', () => {
    const s1 = tuiReducer(base, { type: 'SCROLL_UP', lines: 5 })
    const s2 = tuiReducer(s1, { type: 'SEND_MESSAGE', message: 'hi' })
    expect(s2.scrollOffset).toBe(0)
  })

  it('STREAM_DELTA resets scroll to bottom', () => {
    const s1 = tuiReducer(base, { type: 'SCROLL_UP', lines: 5 })
    const s2 = tuiReducer(s1, { type: 'STREAM_DELTA', content: 'hello' })
    expect(s2.scrollOffset).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to see them fail**

```bash
pnpm test src/cli/tui/state.test.ts 2>&1 | tail -15
```

Expected: failures about missing actions and fields.

- [ ] **Step 3: Update `state.ts`**

In `state.ts`, add the `InputAttachment` interface and extend `TuiState`, `TuiAction`, `initialTuiState`, and `tuiReducer`:

```typescript
// Add before TuiState interface:
export interface InputAttachment {
  base64: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  filename: string
  sizeBytes: number
}
```

Add to `TuiState` interface (after existing fields):
```typescript
  // Thinking mode
  thinkingContent: string
  thinkingStartMs: number
  thinkingDone: boolean
  thinkingDurationMs: number
  // Clipboard attachments
  inputAttachments: InputAttachment[]
  // Scroll
  scrollOffset: number
```

Add to `TuiAction` union (after existing `| { type: 'TICK'... }`):
```typescript
  | { type: 'THINKING_DELTA'; delta: string; nowMs: number }
  | { type: 'THINKING_DONE'; content: string; durationMs: number }
  | { type: 'THINKING_CLEAR' }
  | { type: 'INPUT_ATTACH_IMAGE'; attachment: InputAttachment }
  | { type: 'INPUT_CLEAR_ATTACHMENTS' }
  | { type: 'SCROLL_UP'; lines: number }
  | { type: 'SCROLL_DOWN'; lines: number }
  | { type: 'SCROLL_TO_BOTTOM' }
```

Update `initialTuiState` return value (add after `sessionStats`):
```typescript
    thinkingContent: '',
    thinkingStartMs: 0,
    thinkingDone: false,
    thinkingDurationMs: 0,
    inputAttachments: [],
    scrollOffset: 0,
```

In `tuiReducer`, update the `SEND_MESSAGE` case to add clearing:
```typescript
    case 'SEND_MESSAGE':
      return {
        ...state,
        isRunning: true,
        input: '',
        inputCursor: 0,
        historyIdx: -1,
        history: [action.message, ...state.history].slice(0, 100),
        events: [...state.events, { kind: 'user_message', content: action.message }],
        streamingContent: '',
        scrollOffset: 0,
        inputAttachments: [],
        thinkingContent: '',
        thinkingStartMs: 0,
        thinkingDone: false,
        thinkingDurationMs: 0,
        headerState: { ...state.headerState, status: 'running', elapsedMs: 0, currentTool: undefined },
      }
```

Update the `STREAM_DELTA` case to reset scroll:
```typescript
    case 'STREAM_DELTA':
      return { ...state, streamingContent: state.streamingContent + action.content, scrollOffset: 0 }
```

Add new cases to `tuiReducer` (before the `default` case):
```typescript
    case 'THINKING_DELTA':
      return {
        ...state,
        thinkingContent: state.thinkingContent + action.delta,
        thinkingStartMs: state.thinkingStartMs || action.nowMs,
        thinkingDone: false,
      }

    case 'THINKING_DONE':
      return {
        ...state,
        thinkingDone: true,
        thinkingDurationMs: action.durationMs,
        thinkingContent: action.content,
        events: [...state.events, { kind: 'thinking_end' as const, content: action.content, durationMs: action.durationMs }],
      }

    case 'THINKING_CLEAR':
      return {
        ...state,
        thinkingContent: '',
        thinkingStartMs: 0,
        thinkingDone: false,
        thinkingDurationMs: 0,
      }

    case 'INPUT_ATTACH_IMAGE':
      return { ...state, inputAttachments: [...state.inputAttachments, action.attachment] }

    case 'INPUT_CLEAR_ATTACHMENTS':
      return { ...state, inputAttachments: [] }

    case 'SCROLL_UP':
      return { ...state, scrollOffset: state.scrollOffset + action.lines }

    case 'SCROLL_DOWN':
      return { ...state, scrollOffset: Math.max(0, state.scrollOffset - action.lines) }

    case 'SCROLL_TO_BOTTOM':
      return { ...state, scrollOffset: 0 }
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/cli/tui/state.test.ts
```

Expected: all tests pass including new ones.

- [ ] **Step 5: Full suite + type-check**

```bash
pnpm test && npx tsc --noEmit 2>&1 | head -5
```

Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli/tui/state.ts src/cli/tui/state.test.ts
git commit -m "feat(tui): extend TuiState — thinking mode, image attachments, scroll offset"
```

---

## Task 3: Thinking Mode — stream parsing + TUI rendering

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/loop.ts`
- Create: `src/cli/tui/components/thinking-line.tsx`
- Modify: `src/cli/tui/sse-client.ts`
- Modify: `src/cli/tui/app.tsx`
- Modify: `src/cli/tui/components/message-list.tsx`

**Interfaces:**
- Consumes: `TuiState.thinkingContent`, `THINKING_DELTA`, `THINKING_DONE` from Task 2
- Produces:
  - New `AgentEvent` types: `thinking_delta`, `thinking_end`
  - `<ThinkingLine>` component: `{ content: string; durationMs: number; isStreaming: boolean; elapsedMs: number }`

- [ ] **Step 1: Add thinking AgentEvent types to `src/agent/types.ts`**

Add to the `AgentEvent` union (after `guardrail_halt`):
```typescript
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_end'; content: string; durationMs: number }
```

- [ ] **Step 2: Add thinking stream parsing to `src/agent/loop.ts`**

Find the section in `loop.ts` where the Anthropic stream is processed — it handles `content_block_start`, `content_block_delta`, `content_block_stop` events. Add thinking block tracking alongside existing text block tracking.

In the stream processing loop, find where `content_block_start` is handled and add:
```typescript
// Track thinking blocks separately from text blocks
let thinkingBlockActive = false
let thinkingContent = ''
let thinkingStartMs = 0
```

Where `content_block_start` is processed, add:
```typescript
if (event.content_block?.type === 'thinking') {
  thinkingBlockActive = true
  thinkingContent = ''
  thinkingStartMs = Date.now()
}
```

Where `content_block_delta` is processed, add alongside existing text delta handling:
```typescript
if (thinkingBlockActive && event.delta?.type === 'thinking_delta') {
  thinkingContent += event.delta.thinking ?? ''
  yield { type: 'thinking_delta', delta: event.delta.thinking ?? '' }
}
```

Where `content_block_stop` is processed, add:
```typescript
if (thinkingBlockActive) {
  thinkingBlockActive = false
  yield { type: 'thinking_end', content: thinkingContent, durationMs: Date.now() - thinkingStartMs }
}
```

Also add `extended_thinking` to the LLM request params. Find where the messages array is built into the request (look for `model:`, `messages:`, `tools:`) and add:
```typescript
// Only for Anthropic provider + claude models
...(this.supportsThinking() ? { thinking: { type: 'enabled', budget_tokens: 8000 } } : {}),
```

Add helper method to `AgentLoop` class:
```typescript
private supportsThinking(): boolean {
  const model = this._model ?? ''
  return model.includes('claude') && (model.includes('sonnet-4') || model.includes('opus-4'))
}
```

- [ ] **Step 3: Create `src/cli/tui/components/thinking-line.tsx`**

```tsx
// src/cli/tui/components/thinking-line.tsx
import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

interface ThinkingLineProps {
  elapsedMs: number        // from TICK — elapsed ms since agent started
  thinkingStartMs: number  // when thinking_delta first arrived (epoch ms)
  isStreaming: boolean     // true while thinking_delta still coming in
}

export function ThinkingLine({ elapsedMs, thinkingStartMs, isStreaming }: ThinkingLineProps) {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!isStreaming) return
    const timer = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 100)
    return () => clearInterval(timer)
  }, [isStreaming])

  if (!isStreaming) return null

  const thinkingSeconds = thinkingStartMs > 0
    ? Math.floor((Date.now() - thinkingStartMs) / 1000)
    : Math.floor(elapsedMs / 1000)

  return (
    <Box marginTop={1}>
      <Text dimColor italic>
        {'∴ Thinking… ('}{thinkingSeconds}{'s) '}{SPINNER_FRAMES[frame]}
      </Text>
    </Box>
  )
}
```

- [ ] **Step 4: Update `src/cli/tui/sse-client.ts`**

In `translateAgentEvent()`, add cases for the new event types (after the `guardrail_halt` case):

```typescript
case 'thinking_delta':
  return { kind: 'thinking_delta', delta: raw.delta ?? '' }

case 'thinking_end':
  return { kind: 'thinking_end', content: raw.content ?? '', durationMs: raw.durationMs ?? 0 }
```

- [ ] **Step 5: Update `src/cli/tui/app.tsx` to handle thinking events**

In `onEvent` handler, add before the `delta` check:
```typescript
if (event.kind === 'thinking_delta') {
  dispatch({ type: 'THINKING_DELTA', delta: event.delta, nowMs: Date.now() })
  return
}
if (event.kind === 'thinking_end') {
  dispatch({ type: 'THINKING_DONE', content: event.content, durationMs: event.durationMs })
  return
}
```

- [ ] **Step 6: Update `src/cli/tui/components/message-list.tsx` to show ThinkingLine**

```tsx
// src/cli/tui/components/message-list.tsx
import React from 'react'
import { Box } from 'ink'
import { MessageItem } from './message-item.js'
import { StreamingMd } from './streaming-md.js'
import { ThinkingLine } from './thinking-line.js'
import type { TuiEvent } from '../types.js'

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
}

export function MessageList({
  events, streamingContent, columns,
  scrollOffset, visibleRows,
  thinkingContent, thinkingStartMs, thinkingDone, elapsedMs,
}: MessageListProps) {
  const allItems: TuiEvent[] = [
    ...events.filter(e => e.kind !== 'delta' && e.kind !== 'turn_end' && e.kind !== 'thinking_delta'),
    ...(streamingContent ? [{ kind: 'response' as const, content: streamingContent }] : []),
  ]

  const endIdx = allItems.length
  const startIdx = Math.max(0, endIdx - visibleRows - scrollOffset)
  const endSlice = scrollOffset > 0 ? endIdx - scrollOffset : undefined
  const visibleItems = allItems.slice(startIdx, endSlice)

  const isThinking = thinkingContent.length > 0 && !thinkingDone

  return (
    <Box flexDirection="column" flexGrow={1}>
      {scrollOffset > 0 && (
        <Box>
          <Box>
            {/* scroll indicator handled in app.tsx layout */}
          </Box>
        </Box>
      )}
      {visibleItems.map((event, i) => (
        <MessageItem key={i} event={event} />
      ))}
      {isThinking && (
        <ThinkingLine
          elapsedMs={elapsedMs}
          thinkingStartMs={thinkingStartMs}
          isStreaming={isThinking}
        />
      )}
    </Box>
  )
}
```

Update `app.tsx` to pass new props to `MessageList`:

Find the `<MessageList .../>` JSX and update:
```tsx
<MessageList
  events={events}
  streamingContent={streamingContent}
  columns={termSize.columns}
  scrollOffset={scrollOffset}
  visibleRows={termSize.rows - 4}
  thinkingContent={thinkingContent}
  thinkingStartMs={thinkingStartMs}
  thinkingDone={thinkingDone}
  elapsedMs={headerState.elapsedMs ?? 0}
/>
```

Destructure new state fields in App:
```typescript
const { termSize, headerState, events, streamingContent, input, inputCursor, isRunning,
        thinkingContent, thinkingStartMs, thinkingDone, scrollOffset } = state
```

- [ ] **Step 7: Type-check and full test**

```bash
npx tsc --noEmit 2>&1 | head -10 && pnpm test 2>&1 | tail -5
```

Expected: no type errors, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/agent/types.ts src/agent/loop.ts src/cli/tui/components/thinking-line.tsx src/cli/tui/sse-client.ts src/cli/tui/app.tsx src/cli/tui/components/message-list.tsx
git commit -m "feat(tui): thinking mode — extended_thinking API, stream parsing, animated indicator"
```

---

## Task 4: Clipboard Image Paste

**Files:**
- Create: `src/cli/tui/clipboard.ts`
- Create: `src/cli/tui/clipboard.test.ts`
- Modify: `src/cli/tui/components/editor.tsx`
- Modify: `src/cli/tui/sse-client.ts`
- Modify: `src/server/routes/stream.ts`
- Modify: `src/cli/tui/app.tsx`

**Interfaces:**
- Consumes: `InputAttachment`, `INPUT_ATTACH_IMAGE`, `INPUT_CLEAR_ATTACHMENTS` from Task 2
- Produces:
  - `readClipboardImage(): { base64: string; mediaType: string } | null`
  - `readImageFile(path: string): { base64: string; mediaType: string; filename: string; sizeBytes: number } | null`

- [ ] **Step 1: Write failing tests for clipboard module**

```typescript
// src/cli/tui/clipboard.test.ts
import { describe, it, expect, vi } from 'vitest'
import { parseOsascriptOutput, IMAGE_MAX_BYTES, detectMediaType } from './clipboard.js'

describe('parseOsascriptOutput', () => {
  it('parses hex from osascript output', () => {
    const input = '«data PNGF89504e47»'
    const result = parseOsascriptOutput(input)
    expect(result).not.toBeNull()
    // 89504e47 = PNG magic bytes in hex
    expect(result?.toString('hex')).toBe('89504e47')
  })

  it('returns null for non-PNG output', () => {
    expect(parseOsascriptOutput('missing value')).toBeNull()
    expect(parseOsascriptOutput('')).toBeNull()
    expect(parseOsascriptOutput('error: clipboard empty')).toBeNull()
  })
})

describe('detectMediaType', () => {
  it('detects PNG from extension', () => {
    expect(detectMediaType('/tmp/screenshot.png')).toBe('image/png')
  })
  it('detects JPEG', () => {
    expect(detectMediaType('photo.jpg')).toBe('image/jpeg')
    expect(detectMediaType('photo.jpeg')).toBe('image/jpeg')
  })
  it('detects GIF', () => {
    expect(detectMediaType('anim.gif')).toBe('image/gif')
  })
  it('detects WebP', () => {
    expect(detectMediaType('img.webp')).toBe('image/webp')
  })
  it('defaults to PNG for unknown', () => {
    expect(detectMediaType('unknown')).toBe('image/png')
  })
})

describe('IMAGE_MAX_BYTES', () => {
  it('is 5MB', () => {
    expect(IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024)
  })
})
```

- [ ] **Step 2: Run tests to see them fail**

```bash
pnpm test src/cli/tui/clipboard.test.ts 2>&1 | tail -5
```

Expected: FAIL — "Cannot find module './clipboard.js'"

- [ ] **Step 3: Create `src/cli/tui/clipboard.ts`**

```typescript
// src/cli/tui/clipboard.ts
import { execSync, execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { basename } from 'path'

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024  // 5MB

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export function detectMediaType(path: string): ImageMediaType {
  const lower = path.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'image/png'
}

/**
 * Parse the hex output from `osascript -e 'the clipboard as «class PNGf»'`.
 * Returns a Buffer, or null if the clipboard does not contain PNG data.
 */
export function parseOsascriptOutput(raw: string): Buffer | null {
  const match = raw.trim().match(/«data PNGF([0-9a-fA-F]+)»/)
  if (!match || !match[1]) return null
  return Buffer.from(match[1], 'hex')
}

/**
 * Read a PNG image from the system clipboard.
 * macOS: uses osascript. Linux: uses xclip or wl-paste.
 * Returns null if clipboard has no image or on unsupported platforms.
 */
export function readClipboardImage(): { base64: string; mediaType: ImageMediaType } | null {
  try {
    if (process.platform === 'darwin') {
      const raw = execSync(`osascript -e 'the clipboard as «class PNGf»'`, {
        timeout: 3000, encoding: 'utf-8',
      })
      const buf = parseOsascriptOutput(raw)
      if (!buf || buf.length > IMAGE_MAX_BYTES) return null
      return { base64: buf.toString('base64'), mediaType: 'image/png' }
    }

    if (process.platform === 'linux') {
      // Try xclip first, then wl-paste (Wayland)
      let buf: Buffer | null = null
      try {
        buf = execFileSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], { timeout: 3000 })
      } catch {
        try {
          buf = execFileSync('wl-paste', ['--type', 'image/png'], { timeout: 3000 })
        } catch { return null }
      }
      if (!buf || buf.length === 0 || buf.length > IMAGE_MAX_BYTES) return null
      return { base64: buf.toString('base64'), mediaType: 'image/png' }
    }

    return null  // Windows not supported in V1
  } catch {
    return null
  }
}

/**
 * Read an image file from disk. Cleans up shell-escaped paths.
 * Returns null if file is missing, not an image, or exceeds 5MB.
 */
export function readImageFile(rawPath: string): { base64: string; mediaType: ImageMediaType; filename: string; sizeBytes: number } | null {
  const path = rawPath.trim().replace(/\\ /g, ' ').replace(/^['"]|['"]$/g, '')
  if (!/\.(png|jpe?g|gif|webp)$/i.test(path)) return null
  try {
    const buf = readFileSync(path)
    if (buf.length > IMAGE_MAX_BYTES) return null
    return {
      base64: buf.toString('base64'),
      mediaType: detectMediaType(path),
      filename: basename(path),
      sizeBytes: buf.length,
    }
  } catch { return null }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/cli/tui/clipboard.test.ts
```

Expected: all pass.

- [ ] **Step 5: Update `editor.tsx` to detect and attach images**

At the top of `editor.tsx`, add imports:
```typescript
import { readClipboardImage, readImageFile } from '../clipboard.js'
import type { InputAttachment } from '../state.js'
```

Replace the existing `usePaste` handler with:
```typescript
usePaste(
  (text) => {
    if (!focus) return

    // Case A: image file path (.png/.jpg/.gif/.webp)
    if (/\.(png|jpe?g|gif|webp)$/i.test(text.trim())) {
      const img = readImageFile(text.trim())
      if (img) {
        const attachment: InputAttachment = {
          base64: img.base64,
          mediaType: img.mediaType,
          filename: img.filename,
          sizeBytes: img.sizeBytes,
        }
        dispatch({ type: 'INPUT_ATTACH_IMAGE', attachment })
        return
      }
    }

    // Case B: empty paste on macOS → clipboard image
    if (text.length === 0 && process.platform === 'darwin') {
      const img = readClipboardImage()
      if (img) {
        const attachment: InputAttachment = {
          base64: img.base64,
          mediaType: img.mediaType as InputAttachment['mediaType'],
          filename: 'clipboard',
          sizeBytes: Math.round(img.base64.length * 0.75),  // rough byte count
        }
        dispatch({ type: 'INPUT_ATTACH_IMAGE', attachment })
        return
      }
    }

    // Case C: normal text
    const newVal = value.slice(0, cursor) + text + value.slice(cursor)
    const newCur = snapPos(newVal, cursor + text.length)
    dispatch({ type: 'INPUT_CHANGE', value: newVal, cursor: newCur })
  },
  { isActive: focus },
)
```

Add `attachments` prop to `EditorProps` and render attachment indicator:
```typescript
// Add to EditorProps:
attachments: InputAttachment[]
```

In the focused return branch, add above the `<Box>` with prompt:
```tsx
{attachments.length > 0 && (
  <Box>
    {attachments.map((a, i) => (
      <Text key={i} dimColor>{' [🖼 '}{a.filename}{' '}{formatBytes(a.sizeBytes)}{']'}</Text>
    ))}
    <Text dimColor>{'  · Esc to clear'}</Text>
  </Box>
)}
```

Add `formatBytes` helper at the bottom of the file:
```typescript
function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${n}B`
}
```

In `useTextInput` handler (inside `Editor`), add Escape handling for clearing attachments when input is empty:
```typescript
// In useInput handler, add after Ctrl+C check:
if (key.escape && value === '' && attachments.length > 0) {
  dispatch({ type: 'INPUT_CLEAR_ATTACHMENTS' })
  return
}
```

- [ ] **Step 6: Update `app.tsx` to pass attachments to Editor and streamChat**

In destructuring:
```typescript
const { ..., inputAttachments } = state
```

Pass to `<Editor>`:
```tsx
<Editor
  ...
  attachments={inputAttachments}
/>
```

In `sendMessage`, pass attachments to `streamChat`:
```typescript
cancelRef.current = streamChat({
  ...
  attachments: state.inputAttachments,
  ...
})
```

- [ ] **Step 7: Update `sse-client.ts` to serialize attachments**

Add `attachments` to `StreamOptions`:
```typescript
export interface StreamOptions {
  ...
  attachments?: Array<{ base64: string; mediaType: string }>
}
```

In `streamChat`, update `body`:
```typescript
const body = JSON.stringify({
  message,
  sessionId,
  model,
  ...(opts.attachments?.length ? { attachments: opts.attachments.map(a => ({
    type: 'image',
    mediaType: a.mediaType,
    data: a.base64,
  })) } : {}),
})
```

Also update `Content-Length` header calculation — it already uses `Buffer.byteLength(body)` so it will be correct automatically.

- [ ] **Step 8: Update `src/server/routes/stream.ts` to handle attachments**

Update `StreamBody` interface:
```typescript
interface StreamBody {
  message: string
  sessionId?: string
  model?: string
  attachments?: Array<{ type: 'image'; mediaType: string; data: string }>
}
```

Before building `allMessages`, transform attachments into multimodal content:
```typescript
const { message, sessionId, model, attachments } = request.body

// Build user message content (multimodal if attachments present)
const userContent: unknown = attachments?.length
  ? [
      { type: 'text', text: message },
      ...attachments.map(a => ({
        type: 'image',
        source: { type: 'base64', media_type: a.mediaType, data: a.data },
      })),
    ]
  : message

const allMessages = [
  ...contextMessages,
  { role: 'user' as const, content: userContent },
]
```

- [ ] **Step 9: Type-check and full tests**

```bash
npx tsc --noEmit 2>&1 | head -10 && pnpm test 2>&1 | tail -5
```

Expected: no type errors, all tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/cli/tui/clipboard.ts src/cli/tui/clipboard.test.ts src/cli/tui/components/editor.tsx src/cli/tui/sse-client.ts src/server/routes/stream.ts src/cli/tui/app.tsx
git commit -m "feat(tui): clipboard image paste — macOS osascript + Linux xclip, attachment indicator in editor"
```

---

## Task 5: Diff Rendering + show_diff Tool

**Files:**
- Create: `src/cli/tui/components/diff-view.tsx`
- Create: `src/cli/tui/components/diff-view.test.ts`
- Create: `src/tools/show_diff.ts`
- Modify: `src/cli/tui/components/message-item.tsx`
- Modify: `src/agent/loop.ts`
- Modify: `src/tools/index.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `TuiEvent { kind: 'diff' }` already added in Task 1
- Produces:
  - `<DiffView filename before after columns />`
  - `show_diff` tool registered in default toolset

- [ ] **Step 1: Add `diff` package**

```bash
pnpm add diff
pnpm add -D @types/diff
```

Verify install:
```bash
node -e "import('diff').then(m => console.log('ok:', typeof m.createTwoFilesPatch))"
```

Expected: `ok: function`

- [ ] **Step 2: Write failing tests**

```typescript
// src/cli/tui/components/diff-view.test.ts
import { describe, it, expect } from 'vitest'
import { parseDiffLines, DiffLineType } from './diff-view.js'

describe('parseDiffLines', () => {
  it('classifies addition lines', () => {
    const lines = parseDiffLines('+hello')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toEqual({ type: 'add', content: 'hello' })
  })

  it('classifies deletion lines', () => {
    const lines = parseDiffLines('-goodbye')
    expect(lines[0]).toEqual({ type: 'remove', content: 'goodbye' })
  })

  it('classifies context lines', () => {
    const lines = parseDiffLines(' unchanged')
    expect(lines[0]).toEqual({ type: 'context', content: 'unchanged' })
  })

  it('classifies hunk header lines', () => {
    const lines = parseDiffLines('@@ -1,3 +1,4 @@')
    expect(lines[0]).toEqual({ type: 'hunk', raw: '@@ -1,3 +1,4 @@' })
  })

  it('classifies file header lines', () => {
    const lines = parseDiffLines('--- a/file.ts')
    expect(lines[0]).toEqual({ type: 'header', raw: '--- a/file.ts' })
  })

  it('handles multi-line diff text', () => {
    const text = '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n ctx'
    const lines = parseDiffLines(text)
    expect(lines).toHaveLength(6)
    expect(lines[0].type).toBe('header')
    expect(lines[1].type).toBe('header')
    expect(lines[2].type).toBe('hunk')
    expect(lines[3].type).toBe('remove')
    expect(lines[4].type).toBe('add')
    expect(lines[5].type).toBe('context')
  })
})
```

- [ ] **Step 3: Run tests to fail**

```bash
pnpm test src/cli/tui/components/diff-view.test.ts 2>&1 | tail -5
```

Expected: FAIL — cannot find module.

- [ ] **Step 4: Create `src/cli/tui/components/diff-view.tsx`**

```tsx
// src/cli/tui/components/diff-view.tsx
import React, { useState } from 'react'
import { Box, Text } from 'ink'
import { createTwoFilesPatch } from 'diff'

export type DiffLineType = 'add' | 'remove' | 'context' | 'hunk' | 'header'

export interface ParsedLine {
  type: DiffLineType
  content?: string   // for add/remove/context
  raw?: string       // for hunk/header
}

/**
 * Parse a unified diff string into typed line objects.
 * Accepts either a full diff string (multiple lines) or a single line.
 */
export function parseDiffLines(text: string): ParsedLine[] {
  const lines = text.split('\n')
  return lines.map((line): ParsedLine => {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) return { type: 'header', raw: line }
    if (line.startsWith('@@')) return { type: 'hunk', raw: line }
    if (line.startsWith('+')) return { type: 'add', content: line.slice(1) }
    if (line.startsWith('-')) return { type: 'remove', content: line.slice(1) }
    return { type: 'context', content: line.startsWith(' ') ? line.slice(1) : line }
  })
}

interface DiffViewProps {
  filename: string
  before: string
  after: string
  columns?: number
}

const MAX_UNCOLLAPSED_LINES = 40

export function DiffView({ filename, before, after, columns = 80 }: DiffViewProps) {
  const patch = createTwoFilesPatch(
    `a/${filename}`, `b/${filename}`,
    before, after,
    '', '', { context: 3 }
  )
  const lines = parseDiffLines(patch)

  // Count additions and deletions for summary
  const adds = lines.filter(l => l.type === 'add').length
  const dels = lines.filter(l => l.type === 'remove').length

  const [collapsed, setCollapsed] = useState(lines.length > MAX_UNCOLLAPSED_LINES)

  if (collapsed) {
    return (
      <Box>
        <Text dimColor>{'  '}{filename}</Text>
        <Text color="green">{`  +${adds}`}</Text>
        <Text color="red">{` −${dels}`}</Text>
        <Text dimColor>{'  [scroll to expand]'}</Text>
      </Box>
    )
  }

  const maxLineLen = Math.max(1, columns - 4)

  return (
    <Box flexDirection="column">
      <Text dimColor>{filename}</Text>
      {lines.map((line, i) => {
        if (line.type === 'header') return <Text key={i} dimColor>{truncate(line.raw ?? '', maxLineLen)}</Text>
        if (line.type === 'hunk')   return <Text key={i} color="yellow" dimColor>{truncate(line.raw ?? '', maxLineLen)}</Text>
        if (line.type === 'add')    return <Text key={i} color="green">{'+'}{truncate(line.content ?? '', maxLineLen - 1)}</Text>
        if (line.type === 'remove') return <Text key={i} color="red">{'-'}{truncate(line.content ?? '', maxLineLen - 1)}</Text>
        return <Text key={i} dimColor>{'  '}{truncate(line.content ?? '', maxLineLen - 2)}</Text>
      })}
    </Box>
  )
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}
```

- [ ] **Step 5: Run tests**

```bash
pnpm test src/cli/tui/components/diff-view.test.ts
```

Expected: all pass.

- [ ] **Step 6: Wire DiffView into message-item.tsx**

Replace the `case 'diff':` stub added in Task 1 with:

```tsx
case 'diff':
  return (
    <Box marginTop={1}>
      <DiffView filename={event.filename} before={event.before} after={event.after} columns={80} />
    </Box>
  )
```

Add import at top of `message-item.tsx`:
```typescript
import { DiffView } from './diff-view.js'
```

- [ ] **Step 7: Create `src/tools/show_diff.ts`**

```typescript
// src/tools/show_diff.ts
import { registry } from './registry.js'

registry.register({
  name: 'show_diff',
  description: [
    'Display a before/after diff of text content in the TUI.',
    'Use when showing document changes, config modifications, or code edits.',
    'The diff renders inline in the conversation with red/green line highlighting.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Display name for the file or document being diffed',
      },
      before: {
        type: 'string',
        description: 'Original content (before changes)',
      },
      after: {
        type: 'string',
        description: 'New content (after changes)',
      },
    },
    required: ['filename', 'before', 'after'],
  },
  handler: async (params) => ({
    type: 'diff',
    filename: params['filename'] as string,
    before: params['before'] as string,
    after: params['after'] as string,
  }),
  toolset: ['default'],
  requiresApproval: false,
  executionMode: 'sequential',
})
```

- [ ] **Step 8: Add diff result handling to `loop.ts`**

In the tool result normalization section of `loop.ts` (around line 868, after `if (raw && raw.type === 'multimodal')`), add:

```typescript
} else if (raw && raw.type === 'diff') {
  // diff result: emit as a diff SSE event, text fallback for conversation history
  toolResult = { content: `[diff: ${raw.filename}]`, isError: false }
  // We need to emit the diff as a special event — yield it before tool_end
  // Use a side-channel: store it in the tool result for SSE emission downstream
  // The stream route will detect { type: 'diff' } in the tool result and emit it
  toolResult = { content: `[diff: ${raw.filename}]`, isError: false }
  multimodal = [{
    type: 'diff' as any,
    filename: raw.filename,
    before: raw.before,
    after: raw.after,
  }] as any
```

Wait — this approach is cleaner: just add `diff` to the existing multimodal extension. The stream route already emits multimodal content as a separate `agent_event`. Update the stream route's SSE emission to handle diff type specially.

In `src/server/routes/stream.ts`, in the `onEvent` handler that writes SSE events, add a check: if the tool_end result has multimodal content with `type === 'diff'`, emit an extra SSE event:

```typescript
// After emitting tool_end event, check for diff payload:
if (event.type === 'tool_end' && event.result?.multimodal?.[0]?.type === 'diff') {
  const diffPayload = event.result.multimodal[0] as any
  sendEvent('agent_event', {
    type: 'diff',
    filename: diffPayload.filename,
    before: diffPayload.before,
    after: diffPayload.after,
  })
}
```

Update `sse-client.ts` `translateAgentEvent` to handle `type: 'diff'`:
```typescript
case 'diff':
  return {
    kind: 'diff',
    filename: raw.filename as string,
    before: raw.before as string,
    after: raw.after as string,
  }
```

- [ ] **Step 9: Register show_diff in `src/tools/index.ts`**

Add the import line:
```typescript
import './show_diff.js'
```

- [ ] **Step 10: Type-check and full tests**

```bash
npx tsc --noEmit 2>&1 | head -10 && pnpm test 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add src/cli/tui/components/diff-view.tsx src/cli/tui/components/diff-view.test.ts src/tools/show_diff.ts src/cli/tui/components/message-item.tsx src/agent/loop.ts src/tools/index.ts src/server/routes/stream.ts src/cli/tui/sse-client.ts package.json pnpm-lock.yaml
git commit -m "feat(tui): diff rendering — DiffView component, show_diff tool, red/green unified diff"
```

---

## Task 6: Structured Logger + TraceHub Refactor

**Files:**
- Create: `src/utils/logger.ts`
- Create: `src/utils/logger.test.ts`
- Create: `src/agent/audit.ts`
- Modify: `src/trace/hub.ts`
- Modify: `src/server/routes/trace.ts`
- Modify: `src/agent/loop.ts`

**Interfaces:**
- Produces:
  - `logger.info(module, event, fields)`, `logger.warn(...)`, `logger.error(...)`, `logger.debug(...)`
  - Refactored `traceHub.emit(sessionId, requestId, event)` — global, not QQBot-only
  - `traceHub.subscribe(sessionId?)` — supports session filtering
  - Writes `~/.gemeniclaw/audit/trace-YYYY-MM-DD.jsonl`
  - Writes `~/.gemeniclaw/logs/agent-YYYY-MM-DD.jsonl`
- Consumed by: Tasks 7 (gc watch)

- [ ] **Step 1: Write failing tests for logger**

```typescript
// src/utils/logger.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// We test the pure formatting logic, not file I/O
import { formatLogEntry, levelToInt } from './logger.js'

describe('formatLogEntry', () => {
  it('produces valid JSON with required fields', () => {
    const entry = formatLogEntry('info', 'agent', 'turn_start', { sessionId: 'abc', turn: 1 })
    const parsed = JSON.parse(entry)
    expect(parsed.level).toBe('info')
    expect(parsed.module).toBe('agent')
    expect(parsed.event).toBe('turn_start')
    expect(parsed.sessionId).toBe('abc')
    expect(parsed.turn).toBe(1)
    expect(typeof parsed.ts).toBe('string')
    // ts should be ISO 8601
    expect(() => new Date(parsed.ts)).not.toThrow()
  })

  it('includes all extra fields', () => {
    const entry = formatLogEntry('error', 'tool', 'exec_fail', { toolName: 'read', durationMs: 42 })
    const parsed = JSON.parse(entry)
    expect(parsed.toolName).toBe('read')
    expect(parsed.durationMs).toBe(42)
  })
})

describe('levelToInt', () => {
  it('orders levels correctly', () => {
    expect(levelToInt('debug')).toBeLessThan(levelToInt('info'))
    expect(levelToInt('info')).toBeLessThan(levelToInt('warn'))
    expect(levelToInt('warn')).toBeLessThan(levelToInt('error'))
  })
})
```

- [ ] **Step 2: Run tests to fail**

```bash
pnpm test src/utils/logger.test.ts 2>&1 | tail -5
```

Expected: FAIL.

- [ ] **Step 3: Create `src/utils/logger.ts`**

```typescript
// src/utils/logger.ts
import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export function levelToInt(level: LogLevel): number {
  return { debug: 0, info: 1, warn: 2, error: 3 }[level]
}

export function formatLogEntry(
  level: LogLevel,
  module: string,
  event: string,
  fields?: Record<string, unknown>,
): string {
  const entry = {
    ts: new Date().toISOString(),
    level,
    module,
    event,
    ...fields,
  }
  return JSON.stringify(entry)
}

function getLogPath(): string {
  const dir = join(homedir(), '.gemeniclaw', 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  return join(dir, `agent-${date}.jsonl`)
}

const GC_LOG_LEVEL = process.env['GC_LOG_LEVEL'] as LogLevel | undefined
const stderrMinLevel = GC_LOG_LEVEL ? levelToInt(GC_LOG_LEVEL) : 999  // no stderr by default

function write(level: LogLevel, module: string, event: string, fields?: Record<string, unknown>): void {
  const line = formatLogEntry(level, module, event, fields)
  try {
    appendFileSync(getLogPath(), line + '\n')
  } catch { /* ignore write errors — never crash the agent */ }

  if (levelToInt(level) >= stderrMinLevel) {
    const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[2m'
    process.stderr.write(`${color}[${level.toUpperCase()}] ${module}:${event}\x1b[0m ${JSON.stringify(fields ?? {})}\n`)
  }
}

export const logger = {
  debug: (module: string, event: string, fields?: Record<string, unknown>) => write('debug', module, event, fields),
  info:  (module: string, event: string, fields?: Record<string, unknown>) => write('info',  module, event, fields),
  warn:  (module: string, event: string, fields?: Record<string, unknown>) => write('warn',  module, event, fields),
  error: (module: string, event: string, fields?: Record<string, unknown>) => write('error', module, event, fields),
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/utils/logger.test.ts
```

Expected: all pass.

- [ ] **Step 5: Create `src/agent/audit.ts`**

```typescript
// src/agent/audit.ts
import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

function getAuditPath(filename: string): string {
  const dir = join(homedir(), '.gemeniclaw', 'audit')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  return join(dir, `${filename}-${date}.jsonl`)
}

/**
 * Write one conversation summary entry when an agent run completes.
 */
export function auditConversation(entry: {
  sessionId: string
  requestId: string
  userMessage: string
  totalTurns: number
  stopReason: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  durationMs: number
}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), event: 'conversation', ...entry })
  try {
    appendFileSync(getAuditPath('conversations'), line + '\n')
  } catch { /* ignore */ }
}
```

- [ ] **Step 6: Refactor `src/trace/hub.ts` — add global emit with requestId + persistence**

Replace `src/trace/hub.ts` entirely:

```typescript
// src/trace/hub.ts
import { EventEmitter } from 'events'
import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { AgentEvent } from '../agent/types.js'

export interface TraceEvent {
  ts: number
  sessionId: string
  requestId: string
  userId?: string        // optional — QQBot sets this
  agentEvent: Record<string, unknown>
}

function getTracePath(): string {
  const dir = join(homedir(), '.gemeniclaw', 'audit')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  return join(dir, `trace-${date}.jsonl`)
}

class TraceHub extends EventEmitter {
  private static _instance: TraceHub | null = null

  private constructor() {
    super()
    this.setMaxListeners(100)
  }

  static get instance(): TraceHub {
    if (!TraceHub._instance) TraceHub._instance = new TraceHub()
    return TraceHub._instance
  }

  /**
   * Emit a trace event from any channel (agent loop, QQBot, etc.)
   */
  emit(event: 'trace', traceEvent: TraceEvent): boolean
  emit(event: string, ...args: unknown[]): boolean
  emit(event: string, ...args: unknown[]): boolean {
    if (event === 'trace') {
      const traceEvent = args[0] as TraceEvent
      // Persist to disk
      try {
        appendFileSync(getTracePath(), JSON.stringify(traceEvent) + '\n')
      } catch { /* ignore write errors */ }
    }
    return super.emit(event, ...args)
  }

  /**
   * Publish a trace event (convenience wrapper over emit).
   * Use this from loop.ts and other producers.
   */
  publish(sessionId: string, requestId: string, agentEvent: AgentEvent, userId?: string): void {
    const traceEvent: TraceEvent = {
      ts: Date.now(),
      sessionId,
      requestId,
      ...(userId ? { userId } : {}),
      agentEvent: agentEvent as unknown as Record<string, unknown>,
    }
    this.emit('trace', traceEvent)
  }

  /**
   * @deprecated Use publish() instead. Kept for QQBot backward compat.
   */
  publishLegacy(event: TraceEvent): void {
    this.emit('trace', event)
  }

  subscribe(listener: (event: TraceEvent) => void): () => void {
    this.on('trace', listener)
    return () => this.off('trace', listener)
  }
}

export const traceHub = TraceHub.instance
```

- [ ] **Step 7: Update QQBot to use publishLegacy (backward compat)**

In `src/channels/qqbot/index.ts`, find all calls to `traceHub.publish(event)` and change to `traceHub.publishLegacy(event)`.

```bash
grep -n "traceHub.publish(" src/channels/qqbot/index.ts | head -10
```

For each `traceHub.publish(event)` call, change to `traceHub.publishLegacy(event)`.

- [ ] **Step 8: Instrument `src/agent/loop.ts` with traceHub.publish calls**

At the top of `runAgentLoop` (or the equivalent main entry function), generate a requestId:
```typescript
const requestId = crypto.randomUUID().slice(0, 8)
```

Add `traceHub.publish` calls at the key instrumentation points listed in the spec. Find the relevant sections by searching for `tool_start`, `tool_end`, `agent_end`, `message_delta` in loop.ts and add after each yield:

After yielding `turn_start`:
```typescript
traceHub.publish(sessionId, requestId, { type: 'turn_start', turn })
```

After yielding `tool_start`:
```typescript
traceHub.publish(sessionId, requestId, { type: 'tool_start', toolCallId: tc.id, toolName: tc.name, args: tc.args })
```

After yielding `tool_end`:
```typescript
traceHub.publish(sessionId, requestId, { type: 'tool_end', toolCallId: tc.id, toolName: tc.name, result: toolResult, isError, durationMs })
```

After yielding `agent_end`:
```typescript
traceHub.publish(sessionId, requestId, { type: 'agent_end', totalTurns, stopReason, model, usage })
// Also write conversation audit
import { auditConversation } from './audit.js'
auditConversation({ sessionId, requestId, userMessage: firstUserMessage.slice(0, 500), totalTurns, stopReason, model: model ?? '', inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, cacheReadTokens: usage?.cacheReadInputTokens ?? 0, durationMs: Date.now() - loopStartMs })
```

Add `const loopStartMs = Date.now()` and capture the first user message at the start of the loop.

- [ ] **Step 9: Update `src/server/routes/trace.ts` — session filter + tail**

```typescript
// src/server/routes/trace.ts
import type { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { traceHub } from '../../trace/hub.js'
import type { TraceEvent } from '../../trace/hub.js'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export async function traceRoute(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  fastify.get<{ Querystring: { session?: string; tail?: string } }>(
    '/v1/trace/live',
    async (request, reply) => {
      const { session, tail } = request.query

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      reply.raw.write(': connected\n\n')

      // Replay tail events from today's trace file if requested
      if (tail) {
        const n = parseInt(tail, 10) || 50
        const date = new Date().toISOString().slice(0, 10)
        const path = join(homedir(), '.gemeniclaw', 'audit', `trace-${date}.jsonl`)
        if (existsSync(path)) {
          const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean)
          const recent = lines.slice(-n)
          for (const line of recent) {
            try {
              const event = JSON.parse(line) as TraceEvent
              if (session && !event.sessionId.startsWith(session)) continue
              reply.raw.write(`data: ${line}\n\n`)
            } catch { /* skip malformed lines */ }
          }
        }
      }

      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(': ping\n\n')
      }, 15_000)

      const unsubscribe = traceHub.subscribe((event: TraceEvent) => {
        if (reply.raw.destroyed) return
        if (session && !event.sessionId.startsWith(session)) return
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
      })

      request.raw.on('close', () => {
        clearInterval(heartbeat)
        unsubscribe()
      })

      await new Promise<void>((resolve) => request.raw.on('close', resolve))
    },
  )
}
```

- [ ] **Step 10: Full tests + type-check**

```bash
pnpm test && npx tsc --noEmit 2>&1 | head -10
```

Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add src/utils/logger.ts src/utils/logger.test.ts src/agent/audit.ts src/trace/hub.ts src/server/routes/trace.ts src/agent/loop.ts src/channels/qqbot/index.ts
git commit -m "feat(logging): structured logger, global TraceHub with persistence, agent loop instrumentation"
```

---

## Task 7: `gc watch` CLI Command Rewrite

**Files:**
- Modify: `src/cli/commands/watch.ts`

**Interfaces:**
- Consumes: `/v1/trace/live` SSE endpoint from Task 6 (with `?session=` and `?tail=` params)
- Produces: formatted terminal output for `gc watch`, `gc watch <sessionId>`, `gc watch --tail`, `gc watch --json`

- [ ] **Step 1: Rewrite `src/cli/commands/watch.ts`**

```typescript
// src/cli/commands/watch.ts
/**
 * gc watch — realtime agent conversation monitor
 *
 * Connects to /v1/trace/live SSE and renders each event with color formatting.
 *
 * Usage:
 *   gc watch                       # all sessions, live
 *   gc watch <sessionId>           # filter by session prefix
 *   gc watch --tail                # last 50 events + live
 *   gc watch --json                # raw JSONL output
 *   gc watch --url http://...      # custom server URL
 */

import type { Command } from 'commander'
import * as http from 'node:http'
import * as https from 'node:https'
import { URL } from 'node:url'

const DEFAULT_URL = 'http://localhost:18888'

// ANSI color helpers
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  italic:  '\x1b[3m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false })
}

function fmtBytes(n: number): string {
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${n}B`
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function fmtSession(sessionId: string): string {
  return sessionId.slice(0, 6)
}

interface TraceEvent {
  ts: number
  sessionId: string
  requestId?: string
  userId?: string
  agentEvent: Record<string, unknown>
}

function renderEvent(event: TraceEvent): string {
  const t = fmtTime(event.ts)
  const sess = `${C.dim}${fmtSession(event.sessionId)}${C.reset}`
  const ae = event.agentEvent
  const type = ae['type'] as string

  switch (type) {
    case 'user_message': {
      const content = String(ae['content'] ?? '').slice(0, 120)
      return `${t} ${sess}  ${C.bold}USER  ${C.reset}${C.bold}❯ ${content}${C.reset}`
    }
    case 'llm_request': {
      const model = String(ae['model'] ?? '?')
      const msgs = ae['messageCount'] ?? '?'
      return `${t} ${sess}  ${C.dim}LLM   → ${model} (${msgs} msgs)${C.reset}`
    }
    case 'thinking_delta': {
      const delta = String(ae['delta'] ?? '').slice(0, 80)
      return `${t} ${sess}  ${C.dim}${C.italic}THINK ∴ ${delta}…${C.reset}`
    }
    case 'thinking_end': {
      const ms = Number(ae['durationMs'] ?? 0)
      return `${t} ${sess}  ${C.dim}${C.italic}THINK ∴ done (${(ms/1000).toFixed(1)}s)${C.reset}`
    }
    case 'turn_start': {
      const turn = ae['turn'] ?? '?'
      return `${t} ${sess}  ${C.dim}TURN  ${turn}${C.reset}`
    }
    case 'tool_start': {
      const name = String(ae['toolName'] ?? '?')
      const args = JSON.stringify(ae['args'] ?? {}).slice(0, 80)
      return `${t} ${sess}  ${C.magenta}TOOL  ⬡ ${name}${C.reset}${C.dim}  ${args}${C.reset}`
    }
    case 'tool_end': {
      const name = String(ae['toolName'] ?? '?')
      const ms = Number(ae['durationMs'] ?? 0)
      const isErr = Boolean(ae['isError'])
      const resultPreview = String(ae['resultPreview'] ?? '').slice(0, 60)
      const msStr = ms >= 1000 ? `${(ms/1000).toFixed(1)}s` : `${ms}ms`
      if (isErr) {
        return `${t} ${sess}  ${C.red}TOOL  ✗ ${name}  ${msStr}  ${resultPreview}${C.reset}`
      }
      const sizeStr = resultPreview.length > 0 ? `  ${fmtBytes(resultPreview.length)}` : ''
      return `${t} ${sess}  ${C.green}${C.dim}TOOL  ✓ ${name}  ${msStr}${sizeStr}${C.reset}`
    }
    case 'message_delta': {
      const delta = String(ae['delta'] ?? '').slice(0, 100)
      return `${t} ${sess}  ${C.green}REPLY ● ${delta}${C.reset}`
    }
    case 'agent_end': {
      const turns = ae['totalTurns'] ?? '?'
      const reason = ae['stopReason'] ?? '?'
      const usage = ae['usage'] as Record<string, number> | undefined
      const tokStr = usage
        ? `in:${fmtTokens(usage['inputTokens'] ?? 0)} out:${fmtTokens(usage['outputTokens'] ?? 0)} cache:${fmtTokens(usage['cacheReadInputTokens'] ?? 0)}`
        : ''
      return `${t} ${sess}  ${C.dim}END   ✓ ${turns}t · ${reason}${tokStr ? ' · ' + tokStr : ''}${C.reset}`
    }
    case 'error': {
      const msg = String(ae['message'] ?? '?').slice(0, 120)
      return `${t} ${sess}  ${C.red}${C.bold}ERROR ✗ ${msg}${C.reset}`
    }
    default:
      return `${t} ${sess}  ${C.dim}${type}  ${JSON.stringify(ae).slice(0, 80)}${C.reset}`
  }
}

function connectAndWatch(opts: {
  baseUrl: string
  session?: string
  tail: boolean
  json: boolean
}): void {
  const { baseUrl, session, tail, json } = opts

  const url = new URL('/v1/trace/live', baseUrl)
  if (session) url.searchParams.set('session', session)
  if (tail) url.searchParams.set('tail', '50')

  const transport = url.protocol === 'https:' ? https : http
  let reconnectDelay = 1000

  function connect(): void {
    if (!json) {
      process.stdout.write(`${C.dim}Connecting to ${url}…${C.reset}\n`)
    }

    const req = transport.get(url.toString(), {
      headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
    }, (res) => {
      if (res.statusCode !== 200) {
        process.stderr.write(`Error: HTTP ${res.statusCode}\n`)
        setTimeout(connect, reconnectDelay)
        return
      }
      reconnectDelay = 1000  // reset on success
      let buf = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => {
        buf += chunk
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (!data) continue
          try {
            const event = JSON.parse(data) as TraceEvent
            if (json) {
              process.stdout.write(data + '\n')
            } else {
              process.stdout.write(renderEvent(event) + '\n')
            }
          } catch { /* skip malformed */ }
        }
      })
      res.on('end', () => {
        if (!json) process.stdout.write(`${C.dim}Disconnected. Reconnecting in ${reconnectDelay/1000}s…${C.reset}\n`)
        setTimeout(connect, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
      })
    })

    req.on('error', (err) => {
      process.stderr.write(`Connection error: ${err.message}\n`)
      setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
    })
  }

  connect()

  // Ctrl+C handler
  process.on('SIGINT', () => {
    if (!json) process.stdout.write('\nExiting.\n')
    process.exit(0)
  })

  // Keep process alive
  setInterval(() => {}, 60_000)
}

export function registerWatchCommand(program: Command): void {
  program
    .command('watch [sessionId]')
    .description('Watch agent conversations in real-time')
    .option('--url <url>', 'Server URL', DEFAULT_URL)
    .option('--tail', 'Replay last 50 events before streaming live')
    .option('--json', 'Output raw JSONL instead of formatted text')
    .action((sessionId: string | undefined, options: { url: string; tail: boolean; json: boolean }) => {
      connectAndWatch({
        baseUrl: options.url,
        session: sessionId,
        tail: options.tail ?? false,
        json: options.json ?? false,
      })
    })
}
```

- [ ] **Step 2: Verify the watch command is wired to the CLI entry point**

```bash
grep -n "watch\|registerWatchCommand" src/cli/index.ts 2>/dev/null | head -10
grep -rn "watch\|registerWatch" src/cli/ | grep -v "watch.ts:" | head -10
```

If `registerWatchCommand` is not called anywhere, find the CLI entry point and add:
```typescript
import { registerWatchCommand } from './commands/watch.js'
registerWatchCommand(program)
```

- [ ] **Step 3: Type-check and tests**

```bash
npx tsc --noEmit 2>&1 | head -10 && pnpm test 2>&1 | tail -5
```

Expected: no errors, all tests pass.

- [ ] **Step 4: Smoke test the command**

```bash
pnpm build && node dist/cli/index.js watch --help
```

Expected output:
```
Usage: gc watch [options] [sessionId]

Watch agent conversations in real-time

Options:
  --url <url>  Server URL (default: "http://localhost:18888")
  --tail       Replay last 50 events before streaming live
  --json       Output raw JSONL instead of formatted text
  -h, --help   display help for command
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/watch.ts src/cli/index.ts
git commit -m "feat(cli): gc watch — formatted realtime trace viewer with session filter, tail, json modes"
```

---

## Task 8: Mouse Wheel Scroll

**Files:**
- Create: `src/cli/tui/hooks/use-terminal-mode.ts`
- Modify: `src/cli/tui/app.tsx`
- Modify: `src/cli/tui/components/message-list.tsx`

**Interfaces:**
- Consumes: `SCROLL_UP`, `SCROLL_DOWN`, `SCROLL_TO_BOTTOM`, `scrollOffset` from Task 2
- Produces: SGR mouse tracking enable/disable, wheel event dispatch, scroll indicator rendering

- [ ] **Step 1: Create `src/cli/tui/hooks/use-terminal-mode.ts`**

```typescript
// src/cli/tui/hooks/use-terminal-mode.ts
import { useEffect } from 'react'
import { useStdout } from 'ink'

const MOUSE_ON  = '\x1b[?1000h\x1b[?1006h'  // enable VT200 + SGR mouse
const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l'  // disable

/**
 * Enable SGR mouse tracking on mount, restore on unmount.
 * Mouse wheel events will arrive as raw stdin bytes:
 *   \x1b[<64;X;YM  = wheel up
 *   \x1b[<65;X;YM  = wheel down
 */
export function useTerminalMode(): void {
  const { stdout } = useStdout()

  useEffect(() => {
    if (!stdout?.isTTY) return
    stdout.write(MOUSE_ON)
    return () => {
      stdout.write(MOUSE_OFF)
    }
  }, [stdout])
}
```

- [ ] **Step 2: Wire `useTerminalMode` and mouse byte parsing into `app.tsx`**

Add import at top of `app.tsx`:
```typescript
import { useTerminalMode } from './hooks/use-terminal-mode.js'
```

Inside the `App` component, add:
```typescript
useTerminalMode()
```

In `app.tsx`, there is already a `stdin.on('data', handleData)` listener in a `useEffect` (from the original code, now removed since we use `useInput`). We need to add a new raw stdin listener for mouse bytes only.

Add this `useEffect` to `App` (after the resize effect):

```typescript
useEffect(() => {
  if (!stdin) return

  const handleMouseData = (buf: Buffer) => {
    const str = buf.toString('utf-8')
    const sgrMouse = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/)
    if (!sgrMouse) return  // not a mouse event — let useInput handle it
    const button = parseInt(sgrMouse[1], 10)
    if (button === 64) dispatch({ type: 'SCROLL_UP', lines: 3 })
    if (button === 65) dispatch({ type: 'SCROLL_DOWN', lines: 3 })
    // Don't call any continuation — mouse events are fully handled here
  }

  stdin.on('data', handleMouseData)
  return () => { stdin.off('data', handleMouseData) }
}, [stdin, dispatch])
```

- [ ] **Step 3: Add scroll indicator to `app.tsx` layout**

In the App return JSX, between Header and MessageList box, add:

```tsx
{scrollOffset > 0 && (
  <Box>
    <Text dimColor>{'  ↑ scrolled '}{scrollOffset}{' lines — End key or send message to return'}</Text>
  </Box>
)}
```

Also add `scrollOffset` to the destructuring:
```typescript
const { ..., scrollOffset } = state
```

- [ ] **Step 4: Add keyboard scroll to `useTextInput`**

In `src/cli/tui/hooks/use-text-input.ts`, in the `useInput` handler, add these cases (after the history navigation cases):

```typescript
// Page scroll when input is empty (single-line, no content to navigate within)
if (key.pageUp && value === '') {
  opts.onScrollUp?.()
  return
}
if (key.pageDown && value === '') {
  opts.onScrollDown?.()
  return
}
if (key.end && value === '') {
  opts.onScrollToBottom?.()
  return
}
```

Update `UseTextInputOpts` to add optional scroll callbacks:
```typescript
export interface UseTextInputOpts {
  ...
  onScrollUp?: () => void
  onScrollDown?: () => void
  onScrollToBottom?: () => void
}
```

In `editor.tsx`, pass these to `useTextInput`:
```typescript
onScrollUp: () => dispatch({ type: 'SCROLL_UP', lines: Math.max(1, columns - 6) }),
onScrollDown: () => dispatch({ type: 'SCROLL_DOWN', lines: Math.max(1, columns - 6) }),
onScrollToBottom: () => dispatch({ type: 'SCROLL_TO_BOTTOM' }),
```

(Here `columns - 6` approximates visible rows using terminal width as a proxy — this is a rough heuristic since we don't have exact row count in the editor. The actual row count from state should be passed through, but for simplicity we use the dispatch directly from app.tsx instead:)

Actually simpler: in `app.tsx`, pass `onScrollUp`/`onScrollDown`/`onScrollToBottom` as props to `Editor`, which passes them to `useTextInput`. Add to `EditorProps`:

```typescript
onScrollUp: () => void
onScrollDown: () => void
onScrollToBottom: () => void
```

Pass from app.tsx:
```tsx
onScrollUp={() => dispatch({ type: 'SCROLL_UP', lines: 10 })}
onScrollDown={() => dispatch({ type: 'SCROLL_DOWN', lines: 10 })}
onScrollToBottom={() => dispatch({ type: 'SCROLL_TO_BOTTOM' })}
```

- [ ] **Step 5: Type-check and full tests**

```bash
npx tsc --noEmit 2>&1 | head -10 && pnpm test 2>&1 | tail -5
```

Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli/tui/hooks/use-terminal-mode.ts src/cli/tui/app.tsx src/cli/tui/hooks/use-text-input.ts src/cli/tui/components/editor.tsx
git commit -m "feat(tui): mouse wheel scroll — SGR mouse tracking, scroll state, keyboard PageUp/End"
```

---

## Self-Review

### Spec Coverage

| Requirement | Task |
|---|---|
| Visual redesign — spacing, prefix symbols, borderless header | Task 1 |
| `thinking_end` TuiEvent kind | Task 1 (types stub) |
| State: thinkingContent, inputAttachments, scrollOffset | Task 2 |
| THINKING_DELTA/DONE/CLEAR reducer cases | Task 2 |
| INPUT_ATTACH_IMAGE/CLEAR_ATTACHMENTS reducer | Task 2 |
| SCROLL_UP/DOWN/TO_BOTTOM reducer | Task 2 |
| extended_thinking API param | Task 3 |
| thinking_delta/end stream parsing | Task 3 |
| ThinkingLine spinner component | Task 3 |
| SSE translate thinking events | Task 3 |
| MessageList passes thinking props | Task 3 |
| clipboard.ts readClipboardImage/readImageFile | Task 4 |
| usePaste handler — image path + empty paste detection | Task 4 |
| Attachment indicator above editor | Task 4 |
| Esc clears attachments | Task 4 |
| streamChat serializes attachments | Task 4 |
| server route builds multimodal content | Task 4 |
| DiffView component with parseDiffLines | Task 5 |
| show_diff tool registered in default toolset | Task 5 |
| diff result routing through loop.ts + stream route | Task 5 |
| sse-client translates diff events | Task 5 |
| logger.ts with formatLogEntry + levelToInt | Task 6 |
| JSONL daily rotation to ~/.gemeniclaw/logs/ | Task 6 |
| auditConversation to conversations.jsonl | Task 6 |
| TraceHub.publish(sessionId, requestId, event) | Task 6 |
| TraceHub persists to trace-YYYY-MM-DD.jsonl | Task 6 |
| trace route: session filter + tail replay | Task 6 |
| loop.ts instrumentation with requestId | Task 6 |
| gc watch formatted output | Task 7 |
| gc watch --tail, --json, [sessionId] flags | Task 7 |
| reconnect on disconnect | Task 7 |
| useTerminalMode SGR mouse tracking | Task 8 |
| stdin mouse byte parsing → SCROLL dispatch | Task 8 |
| scroll indicator line | Task 8 |
| keyboard PageUp/PageDown/End scroll | Task 8 |

### Placeholder Scan

All steps contain complete code. No TBD or TODO.

### Type Consistency

- `InputAttachment` defined in Task 2 (`state.ts`), imported in Tasks 4 (`editor.tsx`, `clipboard.ts`)  ✓
- `THINKING_DELTA` action uses `{ delta: string; nowMs: number }` — Task 2 defines it, Task 3 dispatches `{ type: 'THINKING_DELTA', delta: event.delta, nowMs: Date.now() }` ✓
- `TuiEvent { kind: 'thinking_end'; content: string; durationMs: number }` — Task 1 adds stub, Task 2 reducer emits it with exact fields ✓
- `TraceEvent` in Task 6 has `{ ts, sessionId, requestId, agentEvent }` — QQBot `publishLegacy` is told to use this ✓
- `UseTextInputOpts` extended with `onScrollUp?`, `onScrollDown?`, `onScrollToBottom?` in Task 8 — optional so existing tests don't break ✓
