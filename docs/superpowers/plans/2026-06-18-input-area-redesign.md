# Input Area Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the TUI input area with a two-row editor (input + status bar), slash command suggestions, /btw ephemeral modal, /bg background execution, and session auto-resume with history backfill.

**Architecture:** Six sequential tasks, each independently shippable. Tasks 1–2 are cosmetic/mechanical. Tasks 3–4 build the command registry and suggestion UI. Tasks 5–6 implement /btw modal and session continuity. All state changes go through the existing `useReducer` in `state.ts`.

**Tech Stack:** TypeScript, React 19, Ink 7.0.6, Vitest, Node ≥ 20

## Global Constraints

- Ink 7.0.6 public API only — no fork
- No new npm dependencies
- TypeScript strict mode; no `any` in new files
- Tests colocated as `*.test.ts` beside the file they test
- `pnpm test` must stay green after every task
- `npx tsc --noEmit` must pass after every task
- Commit after every task

---

## Task 1: Turn Weakening + Scroll Smoothness

**Files:**
- Modify: `src/cli/tui/components/message-item.tsx`
- Modify: `src/cli/tui/components/message-list.tsx`
- Modify: `src/cli/tui/state.ts`
- Modify: `src/cli/tui/state.test.ts`
- Modify: `src/cli/tui/app.tsx`

**Interfaces:**
- Produces: `SET_MAX_SCROLL_OFFSET` action, `maxScrollOffset` state field
- Consumed by: Task 3 (visibleRows computation), Task 5 (layout height)

- [ ] **Step 1: Remove turn_start from message-item.tsx**

In `src/cli/tui/components/message-item.tsx`, find the `turn_start` case and replace it:

```tsx
case 'turn_start':
  return null
```

- [ ] **Step 2: Add maxScrollOffset to state.ts**

In `src/cli/tui/state.ts`, add `maxScrollOffset: number` to `TuiState` after `scrollOffset`:

```typescript
  scrollOffset: number
  maxScrollOffset: number
```

Add to `TuiAction` union (after `SCROLL_TO_BOTTOM`):
```typescript
  | { type: 'SET_MAX_SCROLL_OFFSET'; value: number }
```

Add to `initialTuiState` return object (after `scrollOffset: 0`):
```typescript
    maxScrollOffset: 0,
```

Add reducer case (before `default`):
```typescript
    case 'SET_MAX_SCROLL_OFFSET':
      return { ...state, maxScrollOffset: action.value }
```

Update `SCROLL_UP` case to clamp at maxScrollOffset:
```typescript
    case 'SCROLL_UP':
      return { ...state, scrollOffset: Math.min(state.scrollOffset + action.lines, state.maxScrollOffset) }
```

- [ ] **Step 3: Write failing tests for new reducer cases**

Add to `src/cli/tui/state.test.ts`:

```typescript
describe('SET_MAX_SCROLL_OFFSET', () => {
  it('sets maxScrollOffset', () => {
    const s = tuiReducer(base, { type: 'SET_MAX_SCROLL_OFFSET', value: 42 })
    expect(s.maxScrollOffset).toBe(42)
  })
})

describe('SCROLL_UP with maxScrollOffset', () => {
  it('clamps at maxScrollOffset', () => {
    const s1 = tuiReducer(base, { type: 'SET_MAX_SCROLL_OFFSET', value: 10 })
    const s2 = tuiReducer(s1, { type: 'SCROLL_UP', lines: 20 })
    expect(s2.scrollOffset).toBe(10)
  })

  it('does not exceed maxScrollOffset on repeated scroll', () => {
    const s1 = tuiReducer(base, { type: 'SET_MAX_SCROLL_OFFSET', value: 5 })
    const s2 = tuiReducer(s1, { type: 'SCROLL_UP', lines: 3 })
    const s3 = tuiReducer(s2, { type: 'SCROLL_UP', lines: 3 })
    expect(s3.scrollOffset).toBe(5)
  })
})
```

Run `pnpm test src/cli/tui/state.test.ts` — expect failures.

- [ ] **Step 4: Run tests — verify they pass now**

```bash
pnpm test src/cli/tui/state.test.ts
```

Expected: all pass.

- [ ] **Step 5: Switch MessageList to margin-based scrolling**

Replace the entire content of `src/cli/tui/components/message-list.tsx`:

```tsx
import React, { useEffect } from 'react'
import { Box } from 'ink'
import { MessageItem } from './message-item.js'
import { StreamingMd } from './streaming-md.js'
import { ThinkingLine } from './thinking-line.js'
import type { TuiEvent, TuiAction } from '../types.js'
import type { TuiState } from '../state.js'

// Re-export TuiAction for convenience — MessageList dispatches SET_MAX_SCROLL_OFFSET
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
  const allItems: TuiEvent[] = [
    ...events.filter(e =>
      e.kind !== 'delta' && e.kind !== 'turn_end' && e.kind !== 'thinking_delta'
    ),
    ...(streamingContent ? [{ kind: 'response' as const, content: streamingContent }] : []),
  ]

  const isThinking = thinkingContent.length > 0 && !thinkingDone

  // Estimate content height: 1.5 rows per item (accounts for wrapped text, tool output)
  const estimatedContentHeight = Math.ceil(allItems.length * 1.5) + (isThinking ? 1 : 0)
  const maxScroll = Math.max(0, estimatedContentHeight - visibleRows)

  useEffect(() => {
    dispatch({ type: 'SET_MAX_SCROLL_OFFSET', value: maxScroll })
  }, [maxScroll, dispatch])

  return (
    <Box height={visibleRows} overflowY="hidden">
      <Box flexDirection="column" marginTop={-scrollOffset}>
        {allItems.map((event, i) => (
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
    </Box>
  )
}
```

- [ ] **Step 6: Update app.tsx — pass dispatch to MessageList, reduce mouse wheel step**

In `src/cli/tui/app.tsx`:

1. Pass `dispatch` to `MessageList`:
```tsx
<MessageList
  events={events}
  streamingContent={streamingContent}
  columns={termSize.columns}
  scrollOffset={scrollOffset}
  visibleRows={termSize.rows - 5}
  thinkingContent={thinkingContent}
  thinkingStartMs={thinkingStartMs}
  thinkingDone={thinkingDone}
  elapsedMs={headerState.elapsedMs ?? 0}
  dispatch={dispatch}
/>
```

Note: `visibleRows` changed from `termSize.rows - 4` to `termSize.rows - 5` (Editor now has 2 rows).

2. In the stdin mouse handler, change wheel step from 3 to 1:
```typescript
if (button === 64) dispatch({ type: 'SCROLL_UP', lines: 1 })
if (button === 65) dispatch({ type: 'SCROLL_DOWN', lines: 1 })
```

- [ ] **Step 7: Type-check and full tests**

```bash
npx tsc --noEmit 2>&1 | head -10 && pnpm test 2>&1 | tail -5
```

Expected: no errors, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/cli/tui/components/message-item.tsx src/cli/tui/components/message-list.tsx src/cli/tui/state.ts src/cli/tui/state.test.ts src/cli/tui/app.tsx
git commit -m "feat(tui): remove turn_start divider; margin-based scroll with maxScrollOffset clamp"
```

---

## Task 2: Two-Row Input Area

**Files:**
- Modify: `src/cli/tui/components/editor.tsx`

**Interfaces:**
- Consumes: `EditorProps` (existing) — adds `isRunning: boolean`, `currentTool?: string`, `suggestions: TuiCommand[]` (Task 3 will pass these; Task 2 stub only needs `isRunning` and `currentTool`)
- Produces: Two-row Editor with `StatusBar` inline component

Note: `suggestions` prop is not wired yet in Task 2 — it gets added in Task 3. Task 2 only adds `isRunning` and `currentTool`.

- [ ] **Step 1: Add isRunning + currentTool to EditorProps and implement StatusBar**

Replace `src/cli/tui/components/editor.tsx` with the full two-row implementation. Add to `EditorProps`:

```typescript
export interface EditorProps {
  value: string
  cursor: number
  columns: number
  focus: boolean
  dispatch: React.Dispatch<TuiAction>
  onSubmit: (message: string) => void
  onCancel: () => void
  onExit: () => void
  attachments: InputAttachment[]
  onScrollUp: () => void
  onScrollDown: () => void
  onScrollToBottom: () => void
  isRunning: boolean          // new
  currentTool?: string        // new
}
```

Add the `StatusBar` inline component at the bottom of `editor.tsx` (before `formatBytes`):

```tsx
function StatusBar({
  focus,
  isRunning,
  currentTool,
  inputEmpty,
  inputIsCommand,
  columns,
}: {
  focus: boolean
  isRunning: boolean
  currentTool?: string
  inputEmpty: boolean
  inputIsCommand: boolean
  columns: number
}) {
  if (!focus) return null

  if (isRunning) {
    const toolLabel = currentTool ? `⚡${currentTool}` : 'Thinking…'
    return (
      <Box justifyContent="space-between">
        <Text dimColor>{'  ● '}{toolLabel}</Text>
        <Text dimColor>{'Ctrl+C interrupt  '}</Text>
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

  // idle + empty
  return (
    <Box justifyContent="space-between">
      <Text dimColor>{'  /btw · /clear · /model · /help'}</Text>
      <Text dimColor>{'? for commands  '}</Text>
    </Box>
  )
}
```

Update the focused return branch to use `flexDirection="column"` with two rows:

```tsx
return (
  <Box flexDirection="column">
    {attachments.length > 0 && (
      <Box>
        {attachments.map((a, i) => (
          <Text key={i} dimColor>{' [🖼 '}{a.filename}{' '}{formatBytes(a.sizeBytes)}{']'}</Text>
        ))}
        <Text dimColor>{'  · Esc to clear'}</Text>
      </Box>
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
    />
  </Box>
)
```

- [ ] **Step 2: Update app.tsx to pass isRunning and currentTool to Editor**

In `src/cli/tui/app.tsx`, update the `<Editor>` call:

```tsx
<Editor
  value={input}
  cursor={inputCursor}
  columns={termSize.columns}
  focus={!isRunning}
  dispatch={dispatch}
  onSubmit={sendMessage}
  onCancel={() => {
    if (cancelRef.current) cancelRef.current()
    dispatch({ type: 'CANCEL' })
  }}
  onExit={exit}
  attachments={inputAttachments}
  onScrollUp={() => dispatch({ type: 'SCROLL_UP', lines: 10 })}
  onScrollDown={() => dispatch({ type: 'SCROLL_DOWN', lines: 10 })}
  onScrollToBottom={() => dispatch({ type: 'SCROLL_TO_BOTTOM' })}
  isRunning={isRunning}
  currentTool={headerState.currentTool}
/>
```

- [ ] **Step 3: Type-check and full tests**

```bash
npx tsc --noEmit 2>&1 | head -10 && pnpm test 2>&1 | tail -5
```

Expected: no errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/cli/tui/components/editor.tsx src/cli/tui/app.tsx
git commit -m "feat(tui): two-row editor — input line + status bar with context-aware hints"
```

---

## Task 3: `/command` Registry + Suggestion Overlay

**Files:**
- Create: `src/cli/tui/commands/registry.ts`
- Create: `src/cli/tui/commands/registry.test.ts`
- Create: `src/cli/tui/commands/handlers.ts`
- Create: `src/cli/tui/components/suggestion-overlay.tsx`
- Modify: `src/cli/tui/state.ts`
- Modify: `src/cli/tui/state.test.ts`
- Modify: `src/cli/tui/hooks/use-text-input.ts`
- Modify: `src/cli/tui/components/editor.tsx`
- Modify: `src/cli/tui/app.tsx`

**Interfaces:**
- Produces:
  - `TuiCommand { name, prefix, description, argHint?, handler }`
  - `COMMANDS: TuiCommand[]` (exported from registry.ts)
  - `filterCommands(query: string): TuiCommand[]`
  - `CommandContext { dispatch, sendMessage, exit, baseUrl, authToken, srv }`
  - `SET_SUGGESTIONS`, `SUGGESTION_MOVE`, `SUGGESTION_CLEAR` actions
  - `suggestions: TuiCommand[]`, `selectedSuggestion: number` in TuiState
  - `<SuggestionOverlay>` component
- Consumed by: Task 4 (/btw handler), Task 5 (/session handler)

- [ ] **Step 1: Write failing tests for registry**

```typescript
// src/cli/tui/commands/registry.test.ts
import { describe, it, expect } from 'vitest'
import { filterCommands, COMMANDS } from './registry.js'

describe('COMMANDS', () => {
  it('has at least 8 commands', () => {
    expect(COMMANDS.length).toBeGreaterThanOrEqual(8)
  })

  it('all commands have prefix starting with /', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.prefix).toMatch(/^\//)
    }
  })

  it('prefix is /name', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.prefix).toBe(`/${cmd.name}`)
    }
  })
})

describe('filterCommands', () => {
  it('empty query returns all commands', () => {
    expect(filterCommands('')).toHaveLength(COMMANDS.length)
  })

  it('prefix match returns matching commands', () => {
    const results = filterCommands('cl')
    expect(results.some(c => c.name === 'clear')).toBe(true)
  })

  it('substring match works', () => {
    const results = filterCommands('session')
    expect(results.some(c => c.name === 'session')).toBe(true)
  })

  it('no match returns empty array', () => {
    expect(filterCommands('zzznomatch')).toHaveLength(0)
  })

  it('returns at most 6 results', () => {
    expect(filterCommands('').length).toBeLessThanOrEqual(6)
  })
})
```

Run: `pnpm test src/cli/tui/commands/registry.test.ts` — expect FAIL.

- [ ] **Step 2: Create registry.ts**

```typescript
// src/cli/tui/commands/registry.ts
import type React from 'react'
import type { TuiAction } from '../state.js'

export interface CommandContext {
  dispatch: React.Dispatch<TuiAction>
  sendMessage: (msg: string) => void
  exit: () => void
  baseUrl: string
  authToken?: string
}

export interface TuiCommand {
  name: string
  prefix: string
  description: string
  argHint?: string
  handler: (args: string, ctx: CommandContext) => void | Promise<void>
}

export const COMMANDS: TuiCommand[] = [
  {
    name: 'btw',
    prefix: '/btw',
    description: '旁路问题，不入主对话',
    argHint: '<question>',
    handler: (_args, _ctx) => { /* wired in Task 4 */ },
  },
  {
    name: 'clear',
    prefix: '/clear',
    description: '清空消息流',
    handler: (_args, ctx) => ctx.dispatch({ type: 'CLEAR' }),
  },
  {
    name: 'session',
    prefix: '/session',
    description: '切换或列出 session',
    argHint: '[id]',
    handler: (_args, _ctx) => { /* wired in Task 5 */ },
  },
  {
    name: 'new',
    prefix: '/new',
    description: '新建 session',
    handler: (_args, ctx) => ctx.dispatch({ type: 'SET_NEW_SESSION' }),
  },
  {
    name: 'model',
    prefix: '/model',
    description: '显示或切换模型',
    argHint: '[name]',
    handler: (args, ctx) => {
      if (args) {
        ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: `Model: ${args} (restart server to apply)` } })
      } else {
        ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: 'Usage: /model <name>' } })
      }
    },
  },
  {
    name: 'cost',
    prefix: '/cost',
    description: '显示本次 token 消耗',
    handler: (_args, ctx) => ctx.dispatch({ type: 'SHOW_COST' }),
  },
  {
    name: 'copy',
    prefix: '/copy',
    description: '复制最后一条回复到剪贴板',
    handler: (_args, ctx) => ctx.dispatch({ type: 'COPY_LAST' }),
  },
  {
    name: 'diff',
    prefix: '/diff',
    description: '显示当前目录 git diff',
    handler: (_args, ctx) => ctx.sendMessage('/diff'),
  },
  {
    name: 'bg',
    prefix: '/bg',
    description: '后台发送，不锁定输入',
    argHint: '<message>',
    handler: (args, ctx) => {
      if (!args.trim()) return
      ctx.dispatch({ type: 'BG_START' })
      // streamChat call wired in Task 4 handlers.ts
    },
  },
  {
    name: 'help',
    prefix: '/help',
    description: '显示命令列表',
    handler: (_args, ctx) => {
      const list = COMMANDS.map(c => `${c.prefix.padEnd(12)} ${c.description}`).join('\n')
      ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: `Commands:\n${list}` } })
    },
  },
  {
    name: 'quit',
    prefix: '/quit',
    description: '退出',
    handler: (_args, ctx) => ctx.exit(),
  },
]

/**
 * Filter commands by query (prefix match + substring fallback).
 * Returns at most 6 results.
 */
export function filterCommands(query: string): TuiCommand[] {
  if (!query) return COMMANDS.slice(0, 6)
  const q = query.toLowerCase()
  const prefixMatches = COMMANDS.filter(c => c.name.startsWith(q))
  const substringMatches = COMMANDS.filter(c => !c.name.startsWith(q) && c.name.includes(q))
  return [...prefixMatches, ...substringMatches].slice(0, 6)
}
```

- [ ] **Step 3: Create handlers.ts (stub — will be fleshed out in Tasks 4 and 5)**

```typescript
// src/cli/tui/commands/handlers.ts
// Full implementations of /btw and /bg are in Task 4.
// Full implementation of /session is in Task 5.
// This file is the single place to put complex handler logic.
export {}
```

- [ ] **Step 4: Run registry tests**

```bash
pnpm test src/cli/tui/commands/registry.test.ts
```

Expected: all pass.

- [ ] **Step 5: Add suggestions fields to state.ts**

In `state.ts`, add after `maxScrollOffset`:
```typescript
  suggestions: TuiCommand[]
  selectedSuggestion: number   // -1 = none selected
```

Import `TuiCommand` at the top of `state.ts`:
```typescript
import type { TuiCommand } from './commands/registry.js'
```

Add to `TuiAction` union:
```typescript
  | { type: 'SET_SUGGESTIONS'; items: TuiCommand[]; selected: number }
  | { type: 'SUGGESTION_MOVE'; delta: number }
  | { type: 'SUGGESTION_CLEAR' }
  | { type: 'SHOW_COST' }
  | { type: 'COPY_LAST' }
  | { type: 'BG_START' }
  | { type: 'BG_DELTA'; content: string }
  | { type: 'BG_DONE' }
  | { type: 'SET_NEW_SESSION' }
  | { type: 'LOAD_HISTORY'; events: TuiEvent[] }
```

Add to `initialTuiState` return:
```typescript
    suggestions: [],
    selectedSuggestion: -1,
    bgRunning: false,
    bgContent: '',
```

Add `bgRunning: boolean` and `bgContent: string` to `TuiState` after `maxScrollOffset`:
```typescript
  bgRunning: boolean
  bgContent: string
```

Add reducer cases:
```typescript
    case 'SET_SUGGESTIONS':
      return { ...state, suggestions: action.items, selectedSuggestion: action.selected }

    case 'SUGGESTION_MOVE': {
      const total = state.suggestions.length
      if (total === 0) return state
      const next = state.selectedSuggestion + action.delta
      return { ...state, selectedSuggestion: Math.max(-1, Math.min(next, total - 1)) }
    }

    case 'SUGGESTION_CLEAR':
      return { ...state, suggestions: [], selectedSuggestion: -1 }

    case 'SHOW_COST': {
      const { totalInput, totalOutput, totalCacheRead } = state.sessionStats
      const msg = `Tokens — in: ${totalInput.toLocaleString()} out: ${totalOutput.toLocaleString()} cache: ${totalCacheRead.toLocaleString()}`
      return { ...state, events: [...state.events, { kind: 'system', message: msg }] }
    }

    case 'COPY_LAST': {
      const last = [...state.events].reverse().find(e => e.kind === 'response')
      if (!last || last.kind !== 'response') return state
      try {
        const { execSync } = require('child_process')
        if (process.platform === 'darwin') execSync(`echo ${JSON.stringify(last.content)} | pbcopy`)
      } catch {}
      return { ...state, events: [...state.events, { kind: 'system', message: 'Copied to clipboard.' }] }
    }

    case 'BG_START':
      return { ...state, bgRunning: true, bgContent: '' }

    case 'BG_DELTA':
      return { ...state, bgContent: state.bgContent + action.content }

    case 'BG_DONE': {
      const bgMsg = state.bgContent ? `[bg] ${state.bgContent}` : ''
      return {
        ...state,
        bgRunning: false,
        bgContent: '',
        events: bgMsg ? [...state.events, { kind: 'response' as const, content: bgMsg }] : state.events,
      }
    }

    case 'SET_NEW_SESSION':
      return {
        ...state,
        events: [],
        streamingContent: '',
        currentSessionId: undefined,
        scrollOffset: 0,
        events: [...state.events, { kind: 'system', message: 'New session started.' }],
      }

    case 'LOAD_HISTORY':
      return { ...state, events: [...action.events, ...state.events] }
```

Note: `SET_NEW_SESSION` has a duplicate `events` key — fix it:
```typescript
    case 'SET_NEW_SESSION':
      return {
        ...state,
        streamingContent: '',
        currentSessionId: undefined,
        scrollOffset: 0,
        events: [{ kind: 'system' as const, message: 'New session started.' }],
      }
```

- [ ] **Step 6: Write failing tests for new state actions**

Add to `src/cli/tui/state.test.ts`:

```typescript
describe('SET_SUGGESTIONS', () => {
  const mockCmd = { name: 'clear', prefix: '/clear', description: 'Clear', handler: () => {} }

  it('sets suggestions and selected', () => {
    const s = tuiReducer(base, { type: 'SET_SUGGESTIONS', items: [mockCmd], selected: 0 })
    expect(s.suggestions).toHaveLength(1)
    expect(s.selectedSuggestion).toBe(0)
  })
})

describe('SUGGESTION_MOVE', () => {
  const mockCmd = { name: 'clear', prefix: '/clear', description: 'Clear', handler: () => {} }

  it('increments selectedSuggestion', () => {
    const s1 = tuiReducer(base, { type: 'SET_SUGGESTIONS', items: [mockCmd, mockCmd], selected: 0 })
    const s2 = tuiReducer(s1, { type: 'SUGGESTION_MOVE', delta: 1 })
    expect(s2.selectedSuggestion).toBe(1)
  })

  it('clamps at max index', () => {
    const s1 = tuiReducer(base, { type: 'SET_SUGGESTIONS', items: [mockCmd], selected: 0 })
    const s2 = tuiReducer(s1, { type: 'SUGGESTION_MOVE', delta: 5 })
    expect(s2.selectedSuggestion).toBe(0)
  })

  it('clamps at -1', () => {
    const s1 = tuiReducer(base, { type: 'SET_SUGGESTIONS', items: [mockCmd], selected: 0 })
    const s2 = tuiReducer(s1, { type: 'SUGGESTION_MOVE', delta: -5 })
    expect(s2.selectedSuggestion).toBe(-1)
  })
})

describe('SHOW_COST', () => {
  it('appends token summary to events', () => {
    const s = tuiReducer(base, { type: 'SHOW_COST' })
    expect(s.events.at(-1)?.kind).toBe('system')
    expect((s.events.at(-1) as any).message).toContain('Tokens')
  })
})

describe('BG_START / BG_DELTA / BG_DONE', () => {
  it('BG_START sets bgRunning', () => {
    const s = tuiReducer(base, { type: 'BG_START' })
    expect(s.bgRunning).toBe(true)
  })

  it('BG_DELTA accumulates content', () => {
    const s1 = tuiReducer(base, { type: 'BG_START' })
    const s2 = tuiReducer(s1, { type: 'BG_DELTA', content: 'hello ' })
    const s3 = tuiReducer(s2, { type: 'BG_DELTA', content: 'world' })
    expect(s3.bgContent).toBe('hello world')
  })

  it('BG_DONE appends response with [bg] prefix', () => {
    const s1 = tuiReducer(base, { type: 'BG_START' })
    const s2 = tuiReducer(s1, { type: 'BG_DELTA', content: 'answer' })
    const s3 = tuiReducer(s2, { type: 'BG_DONE' })
    expect(s3.bgRunning).toBe(false)
    expect(s3.bgContent).toBe('')
    expect((s3.events.at(-1) as any).content).toContain('[bg]')
  })
})

describe('SET_NEW_SESSION', () => {
  it('clears events except system message', () => {
    const s1 = tuiReducer(base, { type: 'SEND_MESSAGE', message: 'hi' })
    const s2 = tuiReducer(s1, { type: 'SET_NEW_SESSION' })
    expect(s2.events).toHaveLength(1)
    expect(s2.events[0]?.kind).toBe('system')
    expect(s2.currentSessionId).toBeUndefined()
  })
})

describe('LOAD_HISTORY', () => {
  it('prepends history events before existing events', () => {
    const s1 = tuiReducer(base, { type: 'SSE_EVENT', event: { kind: 'system', message: 'current' } })
    const history = [{ kind: 'user_message' as const, content: 'old msg' }]
    const s2 = tuiReducer(s1, { type: 'LOAD_HISTORY', events: history })
    expect(s2.events[0]).toEqual(history[0])
    expect(s2.events.at(-1)?.kind).toBe('system')
  })
})
```

Run: `pnpm test src/cli/tui/state.test.ts` — expect some failures (import error on TuiCommand).

- [ ] **Step 7: Run state tests — verify they pass**

```bash
pnpm test src/cli/tui/state.test.ts
```

Expected: all pass. Fix any TS import errors.

- [ ] **Step 8: Create SuggestionOverlay component**

```tsx
// src/cli/tui/components/suggestion-overlay.tsx
import React from 'react'
import { Box, Text } from 'ink'
import type { TuiCommand } from '../commands/registry.js'

interface SuggestionOverlayProps {
  suggestions: TuiCommand[]
  selectedSuggestion: number
  columns: number
}

export function SuggestionOverlay({ suggestions, selectedSuggestion, columns }: SuggestionOverlayProps) {
  if (suggestions.length === 0) return null

  return (
    <Box flexDirection="column" flexShrink={0}>
      {suggestions.map((cmd, i) => {
        const isSelected = i === selectedSuggestion
        const descMaxLen = Math.max(0, columns - cmd.prefix.length - (cmd.argHint?.length ?? 0) - 8)
        const desc = cmd.description.length > descMaxLen
          ? cmd.description.slice(0, descMaxLen - 1) + '…'
          : cmd.description
        return (
          <Box key={cmd.name}>
            <Text inverse={isSelected} color={isSelected ? undefined : 'white'} dimColor={!isSelected}>
              {isSelected ? '▶ ' : '  '}
              {cmd.prefix.padEnd(10)}
              {' '}
              {desc.padEnd(descMaxLen)}
              {cmd.argHint ? `  ${cmd.argHint}` : ''}
            </Text>
          </Box>
        )
      })}
      <Text dimColor>{'─'.repeat(Math.max(0, columns))}</Text>
    </Box>
  )
}
```

- [ ] **Step 9: Wire command detection into editor.tsx and app.tsx**

In `editor.tsx`, add `suggestions` and `selectedSuggestion` to `EditorProps`:
```typescript
  suggestions: TuiCommand[]
  selectedSuggestion: number
```

Add import at top:
```typescript
import type { TuiCommand } from '../commands/registry.js'
```

Update `useTextInput` opts to handle suggestion keyboard inside `onEscape` and pass suggestion navigation callbacks. In `editor.tsx`'s `useTextInput` call, update `onEscape`:
```typescript
onEscape: () => {
  if (suggestions.length > 0) {
    dispatch({ type: 'SUGGESTION_CLEAR' })
    return
  }
  if (value === '' && attachments.length > 0) {
    dispatch({ type: 'INPUT_CLEAR_ATTACHMENTS' })
  }
},
```

In `app.tsx`:

1. Import `filterCommands` and `COMMANDS`:
```typescript
import { filterCommands, COMMANDS } from './commands/registry.js'
```

2. Destructure `suggestions` and `selectedSuggestion` from state:
```typescript
const { ..., suggestions, selectedSuggestion, bgRunning } = state
```

3. Add `useEffect` that updates suggestions when input changes:
```typescript
useEffect(() => {
  if (input.startsWith('/')) {
    const query = input.slice(1)
    const items = filterCommands(query)
    dispatch({ type: 'SET_SUGGESTIONS', items, selected: items.length > 0 ? 0 : -1 })
  } else if (suggestions.length > 0) {
    dispatch({ type: 'SUGGESTION_CLEAR' })
  }
}, [input])
```

4. Add `SuggestionOverlay` to the layout between MessageList and Editor:
```tsx
import { SuggestionOverlay } from './components/suggestion-overlay.js'
// ...
<SuggestionOverlay
  suggestions={suggestions}
  selectedSuggestion={selectedSuggestion}
  columns={termSize.columns}
/>
```

5. Pass `suggestions` and `selectedSuggestion` to `Editor`:
```tsx
suggestions={suggestions}
selectedSuggestion={selectedSuggestion}
```

6. Update `sendMessage` to intercept slash commands:

Find the existing command checks (`/quit`, `/clear` etc.) and replace the whole block with:
```typescript
const sendMessage = useCallback((message: string) => {
  // Check for slash commands
  const matchedCmd = COMMANDS.find(c =>
    message === c.prefix ||
    message.startsWith(c.prefix + ' ')
  )
  if (matchedCmd) {
    const args = message.startsWith(matchedCmd.prefix + ' ')
      ? message.slice(matchedCmd.prefix.length + 1)
      : ''
    dispatch({ type: 'SUGGESTION_CLEAR' })
    matchedCmd.handler(args, {
      dispatch,
      sendMessage: (msg) => sendToServer(msg),
      exit,
      baseUrl: srv.baseUrl,
      authToken: srv.authToken,
    })
    return
  }
  // Legacy inline commands (kept for compatibility)
  if (message === '/quit' || message === '/exit' || message === '/q') { exit(); return }
  sendToServer(message)
}, [...])
```

Extract the server-send logic to a separate `sendToServer` function to avoid circular reference:
```typescript
const sendToServer = useCallback((message: string) => {
  if (state.isRunning) {
    dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: 'Agent is running — press Ctrl+C to interrupt' } })
    return
  }
  dispatch({ type: 'SEND_MESSAGE', message })
  // ... rest of existing streamChat logic
}, [state.isRunning, state.currentSessionId, srv, opts.model])
```

Also add `↑`/`↓` suggestion navigation in `useTextInput`'s `onHistoryUp`/`onHistoryDown` when suggestions are open:
Pass to Editor (and forward to `useTextInput`):
```typescript
onHistoryUp: () => {
  if (suggestions.length > 0) {
    dispatch({ type: 'SUGGESTION_MOVE', delta: -1 })
  } else {
    dispatch({ type: 'INPUT_HISTORY_UP' })
  }
},
onHistoryDown: () => {
  if (suggestions.length > 0) {
    dispatch({ type: 'SUGGESTION_MOVE', delta: 1 })
  } else {
    dispatch({ type: 'INPUT_HISTORY_DOWN' })
  }
},
```

- [ ] **Step 10: Type-check and full tests**

```bash
npx tsc --noEmit 2>&1 | head -10 && pnpm test 2>&1 | tail -5
```

Expected: no errors, all tests pass.

- [ ] **Step 11: Commit**

```bash
git add src/cli/tui/commands/ src/cli/tui/components/suggestion-overlay.tsx src/cli/tui/state.ts src/cli/tui/state.test.ts src/cli/tui/components/editor.tsx src/cli/tui/app.tsx
git commit -m "feat(tui): slash command registry + suggestion overlay with keyboard navigation"
```

---

## Task 4: `/btw` Modal + `/bg` Background + ephemeral server support

**Files:**
- Create: `src/cli/tui/components/btw-modal.tsx`
- Modify: `src/cli/tui/state.ts`
- Modify: `src/cli/tui/state.test.ts`
- Modify: `src/cli/tui/commands/handlers.ts`
- Modify: `src/cli/tui/commands/registry.ts`
- Modify: `src/cli/tui/sse-client.ts`
- Modify: `src/server/routes/stream.ts`
- Modify: `src/cli/tui/app.tsx`

**Interfaces:**
- Consumes: `streamChat` from `sse-client.ts` (adds `ephemeral` field), `BG_START/BG_DELTA/BG_DONE` from Task 3
- Produces:
  - `BtwPhase` type, `btwState: BtwPhase` in TuiState
  - `BTW_START/BTW_DELTA/BTW_DONE/BTW_CLOSE/BTW_SCROLL` actions
  - `<BtwModal>` component
  - `ephemeral?: boolean` in `StreamOptions` and `StreamBody`

- [ ] **Step 1: Add ephemeral to sse-client.ts**

In `src/cli/tui/sse-client.ts`, add `ephemeral?: boolean` to `StreamOptions`:

```typescript
export interface StreamOptions {
  baseUrl: string
  message: string
  sessionId?: string
  model?: string
  authToken?: string
  attachments?: Array<{ base64: string; mediaType: string }>
  ephemeral?: boolean   // add this
  onEvent: (event: TuiEvent) => void
  onSessionId: (sessionId: string) => void
  onDone: () => void
  onError: (err: Error) => void
}
```

In `streamChat`, add `ephemeral` to the body:
```typescript
const { baseUrl, message, sessionId, model, authToken, attachments, ephemeral, onEvent, onSessionId, onDone, onError } = opts
// ...
const body = JSON.stringify({
  message,
  sessionId,
  model,
  ...(ephemeral ? { ephemeral: true } : {}),
  ...(attachments?.length ? { attachments: attachments.map(a => ({ type: 'image', mediaType: a.mediaType, data: a.base64 })) } : {}),
})
```

Also update `Content-Length` — it already uses `Buffer.byteLength(body)`, no change needed.

- [ ] **Step 2: Add ephemeral to stream.ts**

In `src/server/routes/stream.ts`, update `StreamBody`:
```typescript
interface StreamBody {
  message: string
  sessionId?: string
  model?: string
  attachments?: Array<{ type: 'image'; mediaType: string; data: string }>
  ephemeral?: boolean   // add this
}
```

Find the `appendTurn` call and wrap with a guard:
```typescript
// Find the line: await opts.strategy.appendTurn(...)
// Wrap it:
if (fullContent && !request.body.ephemeral) {
  try {
    await opts.strategy.appendTurn(
      sid,
      { role: 'user' as const, content: userContent as string | ContentPart[] },
      { role: 'assistant', content: fullContent },
    )
  } catch (err) {
    console.error('[streamRoute] appendTurn failed:', err)
  }
}
```

- [ ] **Step 3: Add btwState to state.ts**

Add `BtwPhase` type and `btwState` field. In `state.ts`:

```typescript
export type BtwPhase =
  | { phase: 'idle' }
  | { phase: 'loading'; question: string; cancelFn: () => void }
  | { phase: 'showing'; question: string; content: string; scrollOffset: number }
```

Add to `TuiState`:
```typescript
  btwState: BtwPhase
```

Add to `initialTuiState`:
```typescript
    btwState: { phase: 'idle' },
```

Add to `TuiAction`:
```typescript
  | { type: 'BTW_START'; question: string; cancelFn: () => void }
  | { type: 'BTW_DELTA'; content: string }
  | { type: 'BTW_DONE' }
  | { type: 'BTW_CLOSE' }
  | { type: 'BTW_SCROLL'; delta: number }
```

Add reducer cases:
```typescript
    case 'BTW_START':
      return { ...state, btwState: { phase: 'loading', question: action.question, cancelFn: action.cancelFn } }

    case 'BTW_DELTA':
      if (state.btwState.phase === 'loading') {
        return { ...state, btwState: { phase: 'showing', question: state.btwState.question, content: action.content, scrollOffset: 0 } }
      }
      if (state.btwState.phase === 'showing') {
        return { ...state, btwState: { ...state.btwState, content: state.btwState.content + action.content } }
      }
      return state

    case 'BTW_DONE':
      if (state.btwState.phase === 'loading') {
        return { ...state, btwState: { phase: 'showing', question: state.btwState.question, content: '(no response)', scrollOffset: 0 } }
      }
      return state

    case 'BTW_CLOSE':
      if (state.btwState.phase !== 'idle') {
        const s = state.btwState
        if (s.phase === 'loading') s.cancelFn()
      }
      return { ...state, btwState: { phase: 'idle' } }

    case 'BTW_SCROLL':
      if (state.btwState.phase === 'showing') {
        const newOffset = Math.max(0, state.btwState.scrollOffset + action.delta)
        return { ...state, btwState: { ...state.btwState, scrollOffset: newOffset } }
      }
      return state
```

- [ ] **Step 4: Write failing tests for btw state**

Add to `src/cli/tui/state.test.ts`:

```typescript
describe('btwState', () => {
  const noop = () => {}

  it('BTW_START sets loading phase', () => {
    const s = tuiReducer(base, { type: 'BTW_START', question: 'what?', cancelFn: noop })
    expect(s.btwState.phase).toBe('loading')
    if (s.btwState.phase === 'loading') expect(s.btwState.question).toBe('what?')
  })

  it('BTW_DELTA from loading transitions to showing', () => {
    const s1 = tuiReducer(base, { type: 'BTW_START', question: 'q', cancelFn: noop })
    const s2 = tuiReducer(s1, { type: 'BTW_DELTA', content: 'answer' })
    expect(s2.btwState.phase).toBe('showing')
    if (s2.btwState.phase === 'showing') expect(s2.btwState.content).toBe('answer')
  })

  it('BTW_DELTA accumulates in showing phase', () => {
    const s1 = tuiReducer(base, { type: 'BTW_START', question: 'q', cancelFn: noop })
    const s2 = tuiReducer(s1, { type: 'BTW_DELTA', content: 'part1' })
    const s3 = tuiReducer(s2, { type: 'BTW_DELTA', content: ' part2' })
    if (s3.btwState.phase === 'showing') expect(s3.btwState.content).toBe('part1 part2')
  })

  it('BTW_CLOSE resets to idle', () => {
    const s1 = tuiReducer(base, { type: 'BTW_START', question: 'q', cancelFn: noop })
    const s2 = tuiReducer(s1, { type: 'BTW_CLOSE' })
    expect(s2.btwState.phase).toBe('idle')
  })

  it('BTW_SCROLL adjusts scrollOffset', () => {
    const s1 = tuiReducer(base, { type: 'BTW_START', question: 'q', cancelFn: noop })
    const s2 = tuiReducer(s1, { type: 'BTW_DELTA', content: 'x' })
    const s3 = tuiReducer(s2, { type: 'BTW_SCROLL', delta: 3 })
    if (s3.btwState.phase === 'showing') expect(s3.btwState.scrollOffset).toBe(3)
  })
})
```

Run `pnpm test src/cli/tui/state.test.ts` — expect failures.

- [ ] **Step 5: Run tests — verify they pass**

```bash
pnpm test src/cli/tui/state.test.ts
```

Expected: all pass.

- [ ] **Step 6: Create BtwModal component**

```tsx
// src/cli/tui/components/btw-modal.tsx
import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import type { BtwPhase } from '../state.js'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const MAX_HEIGHT = 12

interface BtwModalProps {
  btwState: BtwPhase
  columns: number
}

export function BtwModal({ btwState, columns }: BtwModalProps) {
  const [frame, setFrame] = useState(0)
  const isLoading = btwState.phase === 'loading'

  useEffect(() => {
    if (!isLoading) return
    const timer = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 100)
    return () => clearInterval(timer)
  }, [isLoading])

  if (btwState.phase === 'idle') return null

  const border = '╌'.repeat(Math.max(0, columns))
  const question = btwState.phase === 'loading' ? btwState.question : btwState.question

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text dimColor>{border}</Text>
      <Text dimColor>{'  /btw  '}<Text>{question}</Text></Text>
      <Text dimColor>{border}</Text>
      {btwState.phase === 'loading' && (
        <Text dimColor italic>{'  ∴ Thinking… '}{SPINNER_FRAMES[frame]}</Text>
      )}
      {btwState.phase === 'showing' && (
        <>
          <Box height={Math.min(MAX_HEIGHT, btwState.content.split('\n').length)} overflowY="hidden">
            <Box flexDirection="column" marginTop={-btwState.scrollOffset}>
              {btwState.content.split('\n').map((line, i) => (
                <Text key={i}>{'  '}{line}</Text>
              ))}
            </Box>
          </Box>
          <Text dimColor>{'  ↑/↓ scroll  Esc close'}</Text>
        </>
      )}
      <Text dimColor>{border}</Text>
    </Box>
  )
}
```

- [ ] **Step 7: Implement /btw and /bg handlers in handlers.ts**

```typescript
// src/cli/tui/commands/handlers.ts
import { streamChat } from '../sse-client.js'
import type { CommandContext } from './registry.js'

export function btwHandler(question: string, ctx: CommandContext): void {
  if (!question.trim()) {
    ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: 'Usage: /btw <question>' } })
    return
  }

  const sessionId = `btw-${Math.random().toString(36).slice(2, 10)}`
  let accContent = ''

  const cancelFn = streamChat({
    baseUrl: ctx.baseUrl,
    authToken: ctx.authToken,
    message: question,
    sessionId,
    ephemeral: true,
    onEvent: (event) => {
      if (event.kind === 'delta') {
        accContent += event.content
        ctx.dispatch({ type: 'BTW_DELTA', content: event.content })
      }
    },
    onSessionId: () => {},
    onDone: () => ctx.dispatch({ type: 'BTW_DONE' }),
    onError: () => ctx.dispatch({ type: 'BTW_DONE' }),
  })

  ctx.dispatch({ type: 'BTW_START', question, cancelFn })
}

export function bgHandler(message: string, ctx: CommandContext): void {
  if (!message.trim()) {
    ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: 'Usage: /bg <message>' } })
    return
  }

  ctx.dispatch({ type: 'BG_START' })

  streamChat({
    baseUrl: ctx.baseUrl,
    authToken: ctx.authToken,
    message,
    onEvent: (event) => {
      if (event.kind === 'delta') {
        ctx.dispatch({ type: 'BG_DELTA', content: event.content })
      }
    },
    onSessionId: () => {},
    onDone: () => ctx.dispatch({ type: 'BG_DONE' }),
    onError: () => ctx.dispatch({ type: 'BG_DONE' }),
  })
}
```

- [ ] **Step 8: Wire handlers into registry.ts**

In `registry.ts`, update the `/btw` and `/bg` handlers to import from `handlers.ts`:

```typescript
import { btwHandler, bgHandler } from './handlers.js'
// ...
// In /btw command:
handler: (args, ctx) => btwHandler(args, ctx),
// In /bg command:
handler: (args, ctx) => bgHandler(args, ctx),
```

- [ ] **Step 9: Wire BtwModal into app.tsx**

Add import:
```typescript
import { BtwModal } from './components/btw-modal.js'
```

Destructure `btwState` from state:
```typescript
const { ..., btwState } = state
```

Add `BtwModal` to layout between `SuggestionOverlay` and `Editor`:
```tsx
<BtwModal btwState={btwState} columns={termSize.columns} />
```

Pass btw scroll/close intercept to Editor. Update the `onEscape` handler already in Editor to also close btw:

In `editor.tsx`, update `onEscape` in `useTextInput`:
```typescript
onEscape: () => {
  // Close btw if open
  if (btwState.phase !== 'idle') {
    dispatch({ type: 'BTW_CLOSE' })
    return
  }
  if (suggestions.length > 0) {
    dispatch({ type: 'SUGGESTION_CLEAR' })
    return
  }
  if (value === '' && attachments.length > 0) {
    dispatch({ type: 'INPUT_CLEAR_ATTACHMENTS' })
  }
},
```

Add `btwState` to `EditorProps`:
```typescript
import type { BtwPhase } from '../state.js'
// in EditorProps:
btwState: BtwPhase
```

Pass scroll to btw when open. In `use-text-input.ts`, add `onBtwScrollUp?` and `onBtwScrollDown?` to `UseTextInputOpts`, or handle it more simply: in `editor.tsx`, add `onBtwScrollUp` and `onBtwScrollDown` to `EditorProps` and pass to `useTextInput`'s `onScrollUp`/`onScrollDown` when btw is showing:

```typescript
// EditorProps additions:
onBtwScrollUp?: () => void
onBtwScrollDown?: () => void

// In useTextInput call:
onScrollUp: btwState.phase !== 'idle' ? onBtwScrollUp : onScrollUp,
onScrollDown: btwState.phase !== 'idle' ? onBtwScrollDown : onScrollDown,
```

In `app.tsx`, pass these to `<Editor>`:
```tsx
onBtwScrollUp={() => dispatch({ type: 'BTW_SCROLL', delta: 1 })}
onBtwScrollDown={() => dispatch({ type: 'BTW_SCROLL', delta: -1 })}
```

Also pass `baseUrl` and `authToken` into the `CommandContext` in `sendMessage`. Update the handler call:
```typescript
matchedCmd.handler(args, {
  dispatch,
  sendMessage: (msg) => sendToServer(msg),
  exit,
  baseUrl: srv.baseUrl,
  authToken: srv.authToken,
})
```

- [ ] **Step 10: Type-check and full tests**

```bash
npx tsc --noEmit 2>&1 | head -10 && pnpm test 2>&1 | tail -5
```

Expected: no errors, all tests pass.

- [ ] **Step 11: Commit**

```bash
git add src/cli/tui/components/btw-modal.tsx src/cli/tui/commands/handlers.ts src/cli/tui/commands/registry.ts src/cli/tui/state.ts src/cli/tui/state.test.ts src/cli/tui/sse-client.ts src/server/routes/stream.ts src/cli/tui/app.tsx src/cli/tui/components/editor.tsx
git commit -m "feat(tui): /btw ephemeral modal + /bg background execution + server ephemeral support"
```

---

## Task 5: Session Continuity — auto-resume + history backfill + `/session` command

**Files:**
- Modify: `src/cli/commands/tui.ts`
- Modify: `src/cli/tui/app.tsx`
- Modify: `src/cli/tui/commands/handlers.ts`
- Modify: `src/cli/tui/commands/registry.ts`

**Interfaces:**
- Consumes: `LOAD_HISTORY`, `SET_NEW_SESSION` from Task 3; sessions API at `GET /v1/sessions?limit=5` and `GET /v1/sessions/{id}/messages?limit=30`
- Produces: `--new` CLI flag, auto-resume from `~/.gemeniclaw/last-session`, history injection on startup

- [ ] **Step 1: Update tui.ts — add --new flag and auto-resume logic**

Replace `src/cli/commands/tui.ts` content:

```typescript
// @ts-nocheck
/**
 * gc tui — interactive Terminal UI
 *
 * USAGE
 *   gc tui                        # auto-resume last session (or new if none)
 *   gc tui --new                  # force new session
 *   gc tui --session <id>         # resume specific session
 *   gc tui --model <name>         # override model
 */

import type { Command } from 'commander'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const LAST_SESSION_PATH = join(homedir(), '.gemeniclaw', 'last-session')

export function getLastSessionId(): string | undefined {
  try {
    if (existsSync(LAST_SESSION_PATH)) {
      const id = readFileSync(LAST_SESSION_PATH, 'utf-8').trim()
      return id || undefined
    }
  } catch {}
  return undefined
}

export function saveLastSessionId(id: string): void {
  try {
    mkdirSync(join(homedir(), '.gemeniclaw'), { recursive: true })
    writeFileSync(LAST_SESSION_PATH, id)
  } catch {}
}

export function registerTuiCommand(program: Command): void {
  program
    .command('tui')
    .description('Interactive Terminal UI — watch every step of the agent in real time')
    .option('-s, --session <id>', 'Resume specific session by ID')
    .option('-m, --model <name>', 'Override model name')
    .option('--new', 'Force new session (ignore last-session)')
    .action(async (opts) => {
      let sessionId = opts.session
      if (!sessionId && !opts.new) {
        sessionId = getLastSessionId()
      }
      const { runTui } = await import('../tui/index.js')
      await runTui({ model: opts.model, sessionId })
    })
}
```

- [ ] **Step 2: Wire saveLastSessionId into app.tsx**

In `src/cli/tui/app.tsx`:

1. Import `saveLastSessionId`:
```typescript
import { saveLastSessionId } from '../commands/tui.js'
```

2. In `onSessionId` callback, also persist the session:
```typescript
onSessionId: (sid) => {
  dispatch({ type: 'SESSION_ID', id: sid })
  saveLastSessionId(sid)
},
```

- [ ] **Step 3: Add history backfill on startup**

In `app.tsx`, after the initial `useEffect` that dispatches system messages, add a new `useEffect` that loads history when a `sessionId` is known at startup:

```typescript
// History backfill — only runs once at startup if sessionId is provided
useEffect(() => {
  const sid = opts.sessionId
  if (!sid) return

  const url = `${srv.baseUrl}/v1/sessions/${encodeURIComponent(sid)}/messages?limit=30`
  fetch(url, {
    headers: srv.authToken ? { Authorization: `Bearer ${srv.authToken}` } : {},
  })
    .then(r => r.ok ? r.json() : null)
    .then((data: any) => {
      if (!data?.messages?.length) return
      const historyEvents = data.messages
        .filter((m: any) => m.role === 'user' || m.role === 'assistant')
        .map((m: any): TuiEvent => m.role === 'user'
          ? { kind: 'user_message', content: String(m.content ?? '') }
          : { kind: 'response', content: String(m.content ?? '') }
        )
      if (historyEvents.length > 0) {
        dispatch({ type: 'LOAD_HISTORY', events: historyEvents })
        dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: `↺ Loaded ${historyEvents.length} messages` } })
      }
    })
    .catch(() => {}) // ignore failures — server may not be running yet
}, [])  // empty deps — run once at mount
```

- [ ] **Step 4: Implement /session handler in handlers.ts**

Add to `src/cli/tui/commands/handlers.ts`:

```typescript
export function sessionHandler(args: string, ctx: CommandContext): void {
  const id = args.trim()

  if (!id) {
    // List recent sessions
    fetch(`${ctx.baseUrl}/v1/sessions?limit=5`, {
      headers: ctx.authToken ? { Authorization: `Bearer ${ctx.authToken}` } : {},
    })
      .then(r => r.ok ? r.json() : null)
      .then((data: any) => {
        if (!data?.sessions?.length) {
          ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: 'No sessions found.' } })
          return
        }
        const lines = data.sessions.map((s: any) => {
          const date = s.updated_at?.slice(0, 10) ?? '?'
          const msgs = s.message_count ?? 0
          const title = s.title ? ` "${s.title}"` : ''
          return `  ${s.id.slice(0, 8)}  ${date}  ${msgs} msgs${title}`
        })
        ctx.dispatch({
          type: 'SSE_EVENT',
          event: { kind: 'system', message: `Sessions:\n${lines.join('\n')}\n(type /session <id> to switch)` },
        })
      })
      .catch(() => ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: 'Could not fetch sessions.' } }))
    return
  }

  // Switch to session — clear events, load history
  ctx.dispatch({ type: 'CLEAR' })
  ctx.dispatch({ type: 'SESSION_ID', id })

  fetch(`${ctx.baseUrl}/v1/sessions/${encodeURIComponent(id)}/messages?limit=30`, {
    headers: ctx.authToken ? { Authorization: `Bearer ${ctx.authToken}` } : {},
  })
    .then(r => r.ok ? r.json() : null)
    .then((data: any) => {
      if (!data?.messages?.length) {
        ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: `Session ${id.slice(0, 8)} — no history.` } })
        return
      }
      const historyEvents = data.messages
        .filter((m: any) => m.role === 'user' || m.role === 'assistant')
        .map((m: any) => m.role === 'user'
          ? { kind: 'user_message' as const, content: String(m.content ?? '') }
          : { kind: 'response' as const, content: String(m.content ?? '') }
        )
      ctx.dispatch({ type: 'LOAD_HISTORY', events: historyEvents })
      ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: `↺ Switched to session ${id.slice(0, 8)}, loaded ${historyEvents.length} messages` } })

      // Persist as last session
      import('../clipboard.js').then(() => {}).catch(() => {})
      try {
        const { writeFileSync, mkdirSync } = require('fs')
        const { join } = require('path')
        const { homedir } = require('os')
        mkdirSync(join(homedir(), '.gemeniclaw'), { recursive: true })
        writeFileSync(join(homedir(), '.gemeniclaw', 'last-session'), id)
      } catch {}
    })
    .catch(() => ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: `Session ${id.slice(0, 8)} not found.` } }))
}
```

- [ ] **Step 5: Wire /session handler in registry.ts**

In `registry.ts`, update `/session` handler:
```typescript
import { btwHandler, bgHandler, sessionHandler } from './handlers.js'
// ...
// In /session command:
handler: (args, ctx) => sessionHandler(args, ctx),
```

- [ ] **Step 6: Type-check and full tests**

```bash
npx tsc --noEmit 2>&1 | head -10 && pnpm test 2>&1 | tail -5
```

Expected: no errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/tui.ts src/cli/tui/app.tsx src/cli/tui/commands/handlers.ts src/cli/tui/commands/registry.ts
git commit -m "feat(tui): session auto-resume from last-session, history backfill, /session command"
```

---

## Self-Review

### Spec Coverage

| Requirement | Task |
|---|---|
| turn_start → null | Task 1 |
| margin-based scroll | Task 1 |
| maxScrollOffset clamp | Task 1 |
| wheel step 1 line | Task 1 |
| Two-row editor (input + status bar) | Task 2 |
| StatusBar: running/command/typing/idle states | Task 2 |
| TuiCommand interface + COMMANDS registry | Task 3 |
| filterCommands() | Task 3 |
| SET_SUGGESTIONS / SUGGESTION_MOVE / SUGGESTION_CLEAR actions | Task 3 |
| SuggestionOverlay component | Task 3 |
| /command keyboard nav (↑↓ Tab Esc Enter) | Task 3 |
| sendMessage intercepts slash commands | Task 3 |
| SHOW_COST / COPY_LAST / BG_START-DELTA-DONE / SET_NEW_SESSION / LOAD_HISTORY | Task 3 |
| ephemeral in StreamOptions + StreamBody | Task 4 |
| appendTurn skipped when ephemeral | Task 4 |
| BtwPhase + btwState + BTW_* actions | Task 4 |
| BtwModal component | Task 4 |
| /btw handler with streamChat | Task 4 |
| /bg handler | Task 4 |
| btw scroll/close via ↑↓/Esc | Task 4 |
| --new CLI flag | Task 5 |
| getLastSessionId / saveLastSessionId | Task 5 |
| auto-resume on startup | Task 5 |
| history backfill via GET /v1/sessions/{id}/messages | Task 5 |
| /session list and switch handler | Task 5 |

### Placeholder Scan

No TBD. All code blocks are complete.

### Type Consistency

- `TuiCommand` defined in `registry.ts`, imported in `state.ts` (for `suggestions: TuiCommand[]`), `editor.tsx`, `app.tsx`, `suggestion-overlay.tsx` ✓
- `BtwPhase` defined in `state.ts`, imported in `btw-modal.tsx` and `editor.tsx` ✓
- `CommandContext.baseUrl` used in `handlers.ts` and passed from `app.tsx` ✓
- `BTW_DELTA.content: string` in actions, accumulated as string in reducer ✓
- `LOAD_HISTORY.events: TuiEvent[]` — reducer prepends to `state.events` ✓
- `onBtwScrollUp?` / `onBtwScrollDown?` in `EditorProps` — optional, not in existing tests, backward compatible ✓
