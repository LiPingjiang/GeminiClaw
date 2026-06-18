# TUI Enhancements Spec

**Date:** 2026-06-18  
**Status:** Approved for implementation

## Overview

Five coordinated improvements to the GeminiClaw TUI and observability layer:

1. **Visual redesign** — spacing, typography, hierarchy (inspired by claude-code)
2. **Thinking mode** — extended_thinking API support with animated status line
3. **Clipboard image paste** — macOS + Linux image paste into conversations
4. **Diff rendering** — red/green unified diff display in message stream
5. **Logging + `gc watch`** — structured audit logs, TraceHub for all channels, live watch CLI

---

## Global Constraints

- Ink 7.0.6 — public API only, no fork
- No new npm dependencies except: `diff` (diff rendering), `@napi-rs/canvas` already planned for browser SOM
- TypeScript strict mode, no `any` in new files
- All new files under `src/`; tests colocated as `*.test.ts`
- `pnpm test` must stay green throughout
- Node ≥ 20

---

## Part 1: Visual Redesign

### Motivation

Current TUI renders all message types with zero vertical spacing, identical visual weight, and a heavy `borderStyle="single"` header. Result: walls of text with no hierarchy.

### Spacing Rules

| Element | Spacing |
|---------|---------|
| `user_message` | `marginTop={1}` — 1 blank line above |
| `response` | `marginTop={1}` |
| tool group (start+end pair) | `marginTop={1}` above first, 0 between start/end |
| `system` | no margin (inline, low-weight) |
| `error` | no margin (inline) |
| `turn_start` | no margin (right-aligned label) |
| `agent_end` | `marginTop={1}` |

### Prefix System

Replace color-as-type-indicator with prefix symbols. Colors become accents only.

```
user_message   ❯ text              white bold, no background
response         text              default fg (no color), paddingLeft=2
tool_start     ⬡ name (args…)     dimColor magenta
tool_end         ✓ name 234ms      dimColor green  (✗ red on error)
thinking       ∴ Thinking… (3s)   dimColor italic
agent_end        ✓ 3 turns · end_turn · 4.2s    dimColor
error          ✗ message          red
system           message           dimColor (no prefix)
turn_start       ─ TURN N ─       dimColor, justifyContent="flex-end"
```

### Color Palette

Only 4 semantic colors, rest via `dimColor`:

- **White/bold** — user input (most important)
- **Green** — successful tool end, agent end summary
- **Red** — errors, tool failures
- **Magenta/dim** — tool names (action, not content)
- **Default + dimColor** — everything secondary

### Header Simplification

Remove `borderStyle="single"`. Replace two-box layout with single-line status bar separated by a plain `─` character drawn with `Text`:

```
GeminiClaw  claude-sonnet-4-6  T2  ⚡read_file  3.2s  ●
──────────────────────────────────────────────────────
in:3.4K out:612 cache:1.2K · sess:abc123  idx:847  /help
```

Top line: brand · model · turn · current tool · elapsed · status dot  
Separator: full-width `─` via `'─'.repeat(columns)`  
Bottom line: token stats · session · index · hint

### Files Changed

- `src/cli/tui/components/message-item.tsx` — new prefix system, margins, colors
- `src/cli/tui/components/header.tsx` — remove border, two-line layout with text separator
- `src/cli/tui/components/message-list.tsx` — no changes needed (margins on items)

---

## Part 2: Thinking Mode

### API Integration

In `src/agent/loop.ts`, when sending requests to Anthropic models that support extended thinking, add:

```typescript
// Injected into request params when thinkingEnabled
thinking: { type: 'enabled', budget_tokens: thinkingBudget }
```

`thinkingBudget` defaults to `8000`. Configurable via server config `agent.thinkingBudget`.

Model support check: only Anthropic provider + model name contains `claude` + model version ≥ sonnet-4. All other providers/models: thinking disabled silently.

### Stream Parsing

The Anthropic stream emits new block types alongside regular `content_block_*` events:

```
content_block_start  { type: 'thinking' }
content_block_delta  { type: 'thinking_delta', thinking: string }
content_block_stop
```

`loop.ts` stream parser recognises these and emits new SSE event types:

```typescript
// New AgentEvent types (src/agent/types.ts)
| { type: 'thinking_delta'; delta: string }
| { type: 'thinking_end';   content: string; durationMs: number }
```

`thinking_end` carries the full accumulated thinking text and total duration.

### TUI State

`TuiState` additions:

```typescript
thinkingContent: string       // accumulated during stream
thinkingStartMs: number       // timestamp when thinking_delta first arrived
thinkingDone: boolean         // true after thinking_end
thinkingDurationMs: number    // set on thinking_end
```

New `TuiAction` entries:

```typescript
| { type: 'THINKING_DELTA'; delta: string; nowMs: number }
| { type: 'THINKING_DONE';  content: string; durationMs: number }
| { type: 'THINKING_CLEAR' }   // on SEND_MESSAGE
```

`SEND_MESSAGE` reducer case also dispatches `THINKING_CLEAR`.

### TUI Rendering

New component `ThinkingLine` in `message-item.tsx` logic (rendered from `streamingContent` area, not events list):

**While thinking** (shown in streaming area above response text):
```
∴ Thinking… (3s) ⠙
```
Spinner cycles through `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` at 100ms intervals via `useAnimation` (Ink built-in) or a `useEffect` timer. Elapsed seconds updated from `TICK` action already in state.

**After thinking, collapsed** (added to events list as `thinking_end` event):
```
∴ Thought for 4s
```
`dimColor italic`, single line, no interaction needed for V1.

**After thinking, expanded** (Ctrl+T toggle — V2, not in this spec):  
Deferred. V1 only shows collapsed summary.

### SSE Translation

`src/cli/tui/sse-client.ts` — `translateAgentEvent()` adds cases for `thinking_delta` and `thinking_end`, mapping to new `TuiEvent` kinds:

```typescript
| { kind: 'thinking_delta'; delta: string }
| { kind: 'thinking_end';   content: string; durationMs: number }
```

`thinking_end` is added to `state.events` (renders as collapsed line in history).  
`thinking_delta` updates `state.thinkingContent` only (not added to events).

### Header Indicator

`HeaderState` adds `thinkingEnabled: boolean`. When true, header shows `∴` symbol near model name.

---

## Part 3: Clipboard Image Paste

### Trigger Detection

In `src/cli/tui/components/editor.tsx`, the existing `usePaste` handler:

```typescript
usePaste((text) => {
  if (!focus) return

  // Case A: image file path
  if (/\.(png|jpe?g|gif|webp)$/i.test(text.trim())) {
    const b64 = readImageFile(text.trim())
    if (b64) { dispatch({ type: 'INPUT_ATTACH_IMAGE', ... }); return }
  }

  // Case B: empty paste on macOS → clipboard image
  if (text.length === 0 && process.platform === 'darwin') {
    const b64 = readClipboardImage()
    if (b64) { dispatch({ type: 'INPUT_ATTACH_IMAGE', ... }); return }
  }

  // Case C: normal text paste
  const newVal = value.slice(0, cursor) + text + value.slice(cursor)
  const newCur = snapPos(newVal, cursor + text.length)
  dispatch({ type: 'INPUT_CHANGE', value: newVal, cursor: newCur })
}, { isActive: focus })
```

### Clipboard Module

New file `src/cli/tui/clipboard.ts`:

```typescript
export function readClipboardImage(): { base64: string; mediaType: string } | null
export function readImageFile(path: string): { base64: string; mediaType: string; filename: string } | null
```

**macOS** (`readClipboardImage`):
```typescript
const hex = execSync(`osascript -e 'the clipboard as «class PNGf»'`, { timeout: 3000 })
// parse «data PNGFxxxx…» → hex → Buffer → base64
```

**Linux** (`readClipboardImage`):
```typescript
// Try xclip first, fallback to wl-paste (Wayland)
execSync('xclip -selection clipboard -t image/png -o', { timeout: 3000 })
```

**Windows**: not supported in V1 (return null).

`readImageFile` uses `readFileSync` with path cleaning (strip backslash escapes, outer quotes).

Both functions cap output at 5MB (reject and return null if larger).

### State Extensions

`TuiState` additions:

```typescript
inputAttachments: InputAttachment[]
```

```typescript
interface InputAttachment {
  base64: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  filename: string        // 'clipboard' or basename of file path
  sizeBytes: number
}
```

New `TuiAction` entries:

```typescript
| { type: 'INPUT_ATTACH_IMAGE'; attachment: InputAttachment }
| { type: 'INPUT_CLEAR_ATTACHMENTS' }
```

`SEND_MESSAGE` reducer case calls `INPUT_CLEAR_ATTACHMENTS` implicitly (clears `inputAttachments: []`).

### Editor Display

In `editor.tsx`, render attachment indicator **above** the prompt line:

```tsx
{attachments.length > 0 && (
  <Box>
    {attachments.map((a, i) => (
      <Text key={i} dimColor> [🖼 {a.filename} {formatBytes(a.sizeBytes)}]</Text>
    ))}
    <Text dimColor> · Esc to clear</Text>
  </Box>
)}
```

Pressing Escape when input is empty dispatches `INPUT_CLEAR_ATTACHMENTS`.

### Send Integration

`app.tsx` `sendMessage()` passes `state.inputAttachments` to `streamChat()`.

`src/cli/tui/sse-client.ts` `StreamOptions` adds `attachments?: InputAttachment[]`.

`streamChat` body serialization:

```typescript
const body = JSON.stringify({
  message,
  sessionId,
  model,
  attachments: attachments?.map(a => ({
    type: 'image',
    mediaType: a.mediaType,
    data: a.base64,
  }))
})
```

Server route (`src/server/routes/stream.ts`) reads attachments and builds multimodal message content before passing to agent loop. Agent loop already supports multimodal `ContentPart[]` — no loop changes needed.

---

## Part 4: Diff Rendering

### New TuiEvent Kind

`src/cli/tui/types.ts` addition:

```typescript
| { kind: 'diff'; filename: string; before: string; after: string; collapsed?: boolean }
```

### New Tool: `show_diff`

`src/tools/show_diff.ts` — registered in `toolset: ['default']`:

```typescript
registry.register({
  name: 'show_diff',
  description: 'Display a before/after diff of file content in the TUI. Use when showing changes to documents, configs, or code.',
  schema: {
    type: 'object',
    properties: {
      filename: { type: 'string' },
      before:   { type: 'string', description: 'Original content' },
      after:    { type: 'string', description: 'New content' },
    },
    required: ['filename', 'before', 'after'],
  },
  handler: async (params) => ({
    type: 'diff',
    filename: params.filename as string,
    before:   params.before as string,
    after:    params.after as string,
  }),
  toolset: ['default'],
  requiresApproval: false,
  executionMode: 'sequential',
})
```

The handler returns a special `type: 'diff'` result envelope. `loop.ts` tool result processing (around line 868 where `raw.type === 'multimodal'` is checked) adds a parallel branch: `if (raw.type === 'diff')` emits a `diff` SSE event with `filename`, `before`, `after` fields. `sse-client.ts` `translateAgentEvent()` maps `type: 'diff'` agent event → `kind: 'diff'` TuiEvent.

### Auto-detection

In `message-item.tsx` `response` case: if `event.content` starts with `--- ` and contains `+++ `, render as `DiffView` instead of plain text.

### DiffView Component

New file `src/cli/tui/components/diff-view.tsx`:

```typescript
import { createTwoFilesPatch } from 'diff'   // npm 'diff' package

interface DiffViewProps {
  filename: string
  before: string
  after: string
}
```

Rendering rules:

```
Line type      Prefix   Color           dimColor
──────────────────────────────────────────────
header (---)   none     dimColor gray   true
hunk (@@ …)   none     yellow          true
deletion (-)   -        red             false
addition (+)   +        green           false
context        (space)  default         true
```

**Collapse logic**: If diff has > 40 rendered lines, show collapsed summary by default:

```
  src/tools/browser.ts  +23 −8
```

`useState(collapsed = lines > 40)`. No keyboard interaction in V1 — user can scroll to see full diff in message history. Collapse state is display-only.

**Long lines**: Truncate at `columns - 4` characters with `…` suffix (prevents horizontal overflow in Ink).

### MessageItem Integration

```tsx
case 'diff':
  return (
    <Box marginTop={1}>
      <DiffView filename={event.filename} before={event.before} after={event.after} />
    </Box>
  )
```

### Dependencies

`diff` npm package — add to `dependencies` in `package.json`. Lightweight (no transitive deps), pure JS.

---

## Part 5: Logging + `gc watch`

### Structured Logger

New file `src/utils/logger.ts` — module-level singleton:

```typescript
interface LogEntry {
  ts: string           // ISO 8601
  level: 'debug' | 'info' | 'warn' | 'error'
  module: string       // 'agent' | 'tool' | 'server' | 'qqbot' | 'memory' ...
  event: string        // 'turn_start' | 'tool_call' | 'llm_request' ...
  sessionId?: string
  requestId?: string
  [key: string]: unknown
}

export const logger = {
  debug(module: string, event: string, fields?: Record<string, unknown>): void
  info(module: string, event: string, fields?: Record<string, unknown>): void
  warn(module: string, event: string, fields?: Record<string, unknown>): void
  error(module: string, event: string, fields?: Record<string, unknown>): void
}
```

**Output destinations**:
1. `~/.gemeniclaw/logs/agent-YYYY-MM-DD.jsonl` — append-only structured JSONL, rotated daily
2. `process.stderr` — human-readable colored format when `GC_LOG_LEVEL` env is set (not printed by default to avoid TUI pollution)

Log file location respects existing `~/.gemeniclaw/` convention.

### TraceHub Refactor

`src/trace/hub.ts` refactored from QQBot-specific to global singleton:

```typescript
export interface TraceEvent {
  ts: number
  sessionId: string
  requestId: string
  agentEvent: AgentEvent
}

export const traceHub = {
  // Called by loop.ts for every channel (not just QQBot)
  emit(sessionId: string, requestId: string, event: AgentEvent): void

  // SSE subscription — used by /v1/trace/live route
  // sessionId=undefined means subscribe to all sessions
  subscribe(sessionId?: string): { [Symbol.asyncIterator](): AsyncIterator<TraceEvent> }

  // Writes to ~/.gemeniclaw/audit/trace-YYYY-MM-DD.jsonl
  // Replaces current in-memory-only behavior
  persist(entry: TraceEvent): void
}
```

**Persistence**: Events written to `~/.gemeniclaw/audit/trace-YYYY-MM-DD.jsonl`. Rotated daily. Kept for 7 days (cleanup on startup).

### Agent Loop Instrumentation

`src/agent/loop.ts` — `traceHub.emit()` calls added at:

| Point | Event type | Key fields |
|-------|-----------|-----------|
| User message received | `user_message` | `content` (first 500 chars), `contentLength` |
| LLM request sent | `llm_request` | `model`, `messageCount`, `estimatedTokens`, `hasThinking` |
| thinking_delta received | `thinking_delta` | `delta` (first 200 chars) |
| thinking_end | `thinking_end` | `durationMs`, `contentLength` |
| tool_start | `tool_start` | `toolName`, `toolCallId`, `args` (full, not truncated) |
| tool_end | `tool_end` | `toolName`, `toolCallId`, `durationMs`, `isError`, `resultPreview` (500 chars) |
| message_delta | `message_delta` | `delta` (omit if > 200 chars for perf) |
| agent_end | `agent_end` | `totalTurns`, `stopReason`, `model`, `usage` (full token breakdown) |
| error | `error` | `message`, `stack` (first line) |

`requestId` generated at the start of each `runAgentLoop()` call via `crypto.randomUUID().slice(0, 8)`, propagated to all emitted events.

### Audit Log Extensions

New file `src/agent/audit.ts` — supplements existing `tool_calls.jsonl`:

**`~/.gemeniclaw/audit/conversations.jsonl`** — one entry per complete agent run:

```jsonl
{"ts":"...","event":"conversation","sessionId":"...","requestId":"...","userMessage":"...","totalTurns":3,"stopReason":"end_turn","model":"claude-sonnet-4-6","inputTokens":3456,"outputTokens":890,"cacheReadTokens":1200,"durationMs":11234}
```

Written on `agent_end`. Enables offline analysis: token spend per session, conversation frequency, model distribution.

### `/v1/trace/live` Route Extension

`src/server/routes/trace.ts` — already exists for QQBot. Extend:

- Accept optional `?session=<id>` query param to filter by session
- Accept `?tail=50` to replay last N persisted events before streaming live
- No auth required (local server, assumed trusted)

### `gc watch` CLI Command

New file `src/cli/commands/watch.ts` — already exists but currently only handles agent loop watching. Add `watch` as a proper subcommand alias with formatted output:

```
gc watch                    # all sessions, live only
gc watch <sessionId>        # filter by session prefix match
gc watch --tail             # last 50 events + live
gc watch --json             # raw JSONL output
```

**Formatted output** (default mode):

```
16:23:41 abc123  USER    ❯ 帮我分析这个文件的性能问题
16:23:41 abc123  LLM     → claude-sonnet-4-6 (12 msgs)
16:23:43 abc123  THINK   ∴ 3s — The user wants performance analysis...
16:23:46 abc123  TOOL    ⬡ read_file  src/tools/browser.ts
16:23:46 abc123  TOOL    ✓ read_file  234ms  3.2KB
16:23:48 abc123  TOOL    ⬡ sandbox_exec  node --prof ...
16:23:52 abc123  TOOL    ✓ sandbox_exec  4.1s  892B
16:23:54 abc123  REPLY   ● 性能瓶颈在第87行的getBrowser()...
16:23:54 abc123  END     ✓ 3t · in:3.4K out:612 cache:1.2K · 11.2s
```

Color scheme:
- `USER` — white bold
- `LLM` — dim
- `THINK` — dim italic
- `TOOL ⬡` — magenta
- `TOOL ✓` — green dim / `✗` red
- `REPLY` — green
- `END` — gray
- `ERROR` — red bold

Implementation: SSE client (Node.js `http.get` streaming) connecting to `/v1/trace/live`, parses events, formats and prints. Reconnects automatically on disconnect (1s backoff).

### Existing Console Logs

Existing `console.log` calls in `loop.ts`, `qqbot/index.ts`, etc. are **not removed** — they continue to work. New `logger` calls are additive. Over time modules can migrate, but not required for this spec.

---

## File Map

### New files
- `src/utils/logger.ts` — structured logger singleton
- `src/agent/audit.ts` — conversations.jsonl writer
- `src/cli/tui/clipboard.ts` — clipboard image reading
- `src/cli/tui/components/diff-view.tsx` — DiffView component
- `src/cli/tui/components/thinking-line.tsx` — ThinkingLine component
- `src/tools/show_diff.ts` — show_diff tool

### Modified files
- `src/cli/tui/components/message-item.tsx` — new visual system + diff + thinking_end cases
- `src/cli/tui/components/header.tsx` — remove border, text separator, thinking indicator
- `src/cli/tui/components/editor.tsx` — image paste detection + attachment display
- `src/cli/tui/components/message-list.tsx` — pass thinkingContent for ThinkingLine
- `src/cli/tui/state.ts` — thinkingContent, thinkingDone, inputAttachments, scrollOffset fields + new actions
- `src/cli/tui/state.test.ts` — new reducer tests
- `src/cli/tui/types.ts` — new TuiEvent kinds (diff, thinking_delta, thinking_end)
- `src/cli/tui/sse-client.ts` — translate thinking + diff events
- `src/cli/tui/app.tsx` — pass attachments to streamChat, handle thinking state, mouse byte interception
- `src/agent/loop.ts` — extended_thinking param, stream parsing, traceHub calls, requestId
- `src/agent/types.ts` — new AgentEvent types for thinking
- `src/trace/hub.ts` — global singleton, persistence
- `src/server/routes/trace.ts` — session filter, tail param
- `src/cli/commands/watch.ts` — formatted gc watch output
- `src/tools/index.ts` — import show_diff
- `package.json` — add `diff` dependency

---

---

## Part 6: Mouse Wheel Scroll

### Problem

Ink 7 (public) has no mouse wheel support. The message list currently has `overflowY="hidden"` which clips content correctly but provides no way to scroll up to read earlier messages. The input bar must stay fixed at the bottom.

### Approach

Ink 7 does not expose mouse events, so we intercept raw stdin bytes ourselves — the same pattern used by `useTextInput` for keyboard handling. This coexists safely because mouse escape sequences start with `\x1b[<` (SGR mouse mode) which is distinct from keyboard escape sequences.

### Mouse Tracking Protocol

On TUI startup, write two escape sequences to stdout to enable SGR mouse tracking:

```
\x1b[?1000h   — enable VT200 mouse tracking (button + wheel events)
\x1b[?1006h   — enable SGR extended coordinates (avoids 223-col limit)
```

On TUI exit (cleanup effect), restore:

```
\x1b[?1000l   — disable mouse tracking
\x1b[?1006l   — disable SGR mode
```

These are added to `useTerminalMode` hook in `src/cli/tui/hooks/use-terminal-mode.ts` (new file, or inline in `app.tsx` useEffect).

### SGR Mouse Escape Parsing

SGR wheel events arrive as:

```
\x1b[<64;X;YM   — wheel up   (button=64)
\x1b[<65;X;YM   — wheel down (button=65)
```

In `app.tsx` `stdin.on('data')` handler (runs alongside `useInput`), check raw buffer before any other processing:

```typescript
const str = buf.toString('utf-8')

// SGR mouse event: \x1b[<Cb;Cx;CyM or ...m
const sgrMouse = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/)
if (sgrMouse) {
  const button = parseInt(sgrMouse[1])
  if (button === 64) dispatch({ type: 'SCROLL_UP',   lines: 3 })
  if (button === 65) dispatch({ type: 'SCROLL_DOWN', lines: 3 })
  return  // don't pass mouse bytes to useInput
}
```

3 lines per wheel tick is the default. No acceleration in V1.

### Scroll State

`TuiState` additions:

```typescript
scrollOffset: number   // lines scrolled up from bottom (0 = at bottom)
```

New `TuiAction` entries:

```typescript
| { type: 'SCROLL_UP';   lines: number }
| { type: 'SCROLL_DOWN'; lines: number }
| { type: 'SCROLL_TO_BOTTOM' }
```

Reducer:

```typescript
case 'SCROLL_UP':
  return { ...state, scrollOffset: state.scrollOffset + action.lines }

case 'SCROLL_DOWN':
  return { ...state, scrollOffset: Math.max(0, state.scrollOffset - action.lines) }

case 'SCROLL_TO_BOTTOM':
  return { ...state, scrollOffset: 0 }
```

`STREAM_DELTA` and `SEND_MESSAGE` also reset `scrollOffset: 0` (auto-follow on new content).

### Visible Window Computation

`MessageList` receives `scrollOffset` and `visibleRows` (= `termSize.rows - headerRows - 1`).

Instead of `overflowY="hidden"` clipping (which hides content with no scroll), we compute which events to show:

```typescript
// message-list.tsx
const allItems = [
  ...events.filter(e => e.kind !== 'delta' && e.kind !== 'turn_end'),
  ...(streamingContent ? [{ kind: 'response', content: streamingContent }] : [])
]

// Each item occupies at least 1 row; approximate: 1 item = 1 row (conservative)
// Show items from tail, offset by scrollOffset
const endIdx = allItems.length
const startIdx = Math.max(0, endIdx - visibleRows - scrollOffset)
const visibleItems = allItems.slice(startIdx, endIdx - scrollOffset || undefined)
```

This is a line-based approximation. Long responses that wrap occupy more than 1 row — in V1 we accept that approximation (over-scrolling will just show fewer items). V2 can measure actual rendered heights.

### Scroll Indicator

When `scrollOffset > 0`, show a fixed indicator line above the message list:

```
  ↑ 12 lines above  (press End or send message to return)
```

Rendered as a `<Box>` with `dimColor` text, positioned between Header and MessageList.

### Keyboard Scroll

`useTextInput` already handles `PageUp`/`PageDown` for cursor movement within multiline input. When input is empty (single line), redirect:

- `PageUp` / `Alt+↑` → `SCROLL_UP lines=visibleRows`
- `PageDown` / `Alt+↓` → `SCROLL_DOWN lines=visibleRows`
- `End` → `SCROLL_TO_BOTTOM`

### Files Changed (additions to Part 5 file map)

- `src/cli/tui/app.tsx` — stdin mouse byte interception, mouse tracking enable/disable
- `src/cli/tui/state.ts` — scrollOffset field + SCROLL_* actions
- `src/cli/tui/components/message-list.tsx` — visible window slice computation
- `src/cli/tui/hooks/use-terminal-mode.ts` (new) — mouse tracking escape sequences in useEffect

---

## What Is NOT Included

- Mouse wheel acceleration (linear-only in V1, no velocity curve) — V2
- Accurate per-item height measurement for scroll offset — V2 (V1 uses 1-item=1-row approximation)
- Thinking expand/collapse interaction (Ctrl+T) — V2
- Windows clipboard image support — V2
- Log rotation / cleanup daemon — startup-time cleanup only
- Thinking budget UI control — config file only
- `gc watch` TUI mode (full Ink rendering) — plain text output only
- Diff syntax highlighting — plain +/- coloring only
- Image resize / compression — reject images > 5MB with error message
