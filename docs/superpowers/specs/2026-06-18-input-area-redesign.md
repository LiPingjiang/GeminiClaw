# Input Area Redesign Spec

**Date:** 2026-06-18  
**Status:** Approved for implementation

## Overview

Six coordinated improvements to the GeminiClaw TUI input area and session management:

1. **Turn weakening** — remove `turn_start` from message stream
2. **Scroll smoothness** — margin-based scrolling, 1-line step
3. **Two-row input** — input line + status/hint line
4. **`/command` system** — slash command registry + suggestion overlay
5. **`/btw` modal** — ephemeral side question with floating answer modal
6. **Session continuity** — auto-resume last session + history backfill on startup

---

## Global Constraints

- Ink 7.0.6 public API only
- TypeScript strict mode; no `any` in new files
- No new npm dependencies
- `pnpm test` green throughout
- Node ≥ 20

---

## Part 1: Turn Weakening

`message-item.tsx` `turn_start` case → `return null`.

Turn information is already visible in the header (`T{N}`). The divider line in the message stream adds visual noise without adding information. Removing it entirely creates more reading flow.

---

## Part 2: Scroll Smoothness

### Problem

Current: items are sliced by count (1 item ≈ 1 row approximation). Scroll step = 3 lines. Result: jumpy, items re-mount on every scroll.

### Solution: margin-based scrolling

Instead of slicing items, render **all items** in an inner Box and shift them up with a negative `marginTop`:

```
<Box height={visibleRows} overflowY="hidden">
  <Box marginTop={-scrollOffset} flexDirection="column">
    {allItems.map(...)}
  </Box>
</Box>
```

`scrollOffset` is now measured in **display rows**, not item count. This gives pixel-accurate scrolling with no item remounting.

### Step size changes

- Mouse wheel: 3 lines → **1 line** per tick (wheel events already fire multiple times during fast scroll)
- PageUp/PageDown: 10 lines (unchanged)
- End: jump to bottom

### maxScrollOffset

`MessageList` computes max scroll on each render and dispatches `SET_MAX_SCROLL_OFFSET` when it changes. This prevents scrolling past the top of content:

```typescript
const contentHeight = /* estimated from allItems.length and average line height */
const maxScroll = Math.max(0, contentHeight - visibleRows)
```

For V1, estimate: 1 item = 1.5 rows (accounts for tool output, wrapped text). This is still an approximation but better than 1:1. True measurement requires Ink layout hooks — deferred to V2.

### State changes

`TuiState` adds:
```typescript
maxScrollOffset: number   // updated by MessageList via SET_MAX_SCROLL_OFFSET
```

`TuiAction` adds:
```typescript
| { type: 'SET_MAX_SCROLL_OFFSET'; value: number }
```

`SCROLL_UP` clamps at `maxScrollOffset`:
```typescript
case 'SCROLL_UP':
  return { ...state, scrollOffset: Math.min(state.scrollOffset + action.lines, state.maxScrollOffset) }
```

### Files changed

- `src/cli/tui/components/message-list.tsx` — margin-based rendering
- `src/cli/tui/state.ts` — maxScrollOffset field + SET_MAX_SCROLL_OFFSET
- `src/cli/tui/app.tsx` — mouse wheel step 3→1

---

## Part 3: Two-Row Input Area

### Layout

```
─────────────────────────────────────────────────────
❯ user input text here|
  /btw · /clear · /model · /help        ? for commands
```

While running:
```
● read_file(src/tools/browser.ts)                Ctrl+C
```

### Editor component changes

`Editor` switches from single Box to `flexDirection="column"` with two rows:

**Row 1 (input line):** unchanged — `❯` prefix + `<Text>{rendered}</Text>`

**Row 2 (status bar):** new inline `StatusBar` component (inside `editor.tsx`, ~25 lines):

| State | Left content | Right content |
|-------|-------------|---------------|
| idle, empty input | `/btw · /clear · /model · /help` | `? for commands` |
| idle, input starts with `/` | `↑↓ select  Tab complete  Esc close` | matched command name |
| idle, non-empty input | (empty) | `Enter send  Shift+Enter newline` |
| running | `● {currentTool or "Thinking…"}` | `Ctrl+C interrupt` |

All status bar text uses `dimColor`.

### Header height adjustment

Header occupies 3 rows (top line + separator + stats). Editor now occupies 2 rows. Total fixed = 5 rows. `visibleRows = termSize.rows - 5`. When SuggestionOverlay is showing, it occupies additional rows above Editor — MessageList's visible height shrinks accordingly.

### Props changes

`EditorProps` adds:
```typescript
isRunning: boolean
currentTool?: string
```

`app.tsx` passes these from `state.headerState`.

---

## Part 4: `/command` Suggestion System

### Command registry

New file `src/cli/tui/commands/registry.ts`:

```typescript
export interface TuiCommand {
  name: string          // 'btw'
  prefix: string        // '/btw'
  description: string   // '旁路问题，不入主对话'
  argHint?: string      // '<question>'
  handler: (args: string, ctx: CommandContext) => void | Promise<void>
}

export interface CommandContext {
  dispatch: React.Dispatch<TuiAction>
  sendMessage: (msg: string) => void
  exit: () => void
}
```

New file `src/cli/tui/commands/handlers.ts` — implementation of each command's handler function.

**Registered commands (in display order):**

| Command | Description | Arg hint |
|---------|-------------|---------|
| `/btw` | 旁路问题，不入主对话 | `<question>` |
| `/clear` | 清空消息流 | — |
| `/session` | 切换或列出 session | `[id]` |
| `/new` | 新建 session | — |
| `/model` | 显示或切换模型 | `[name]` |
| `/cost` | 显示本次 token 消耗 | — |
| `/copy` | 复制最后一条回复到剪贴板 | — |
| `/diff` | 显示当前目录 git diff | — |
| `/bg` | 后台发送，不锁定输入 | `<message>` |
| `/help` | 显示命令列表 | — |
| `/quit` | 退出 | — |

### Filtering

When `value.startsWith('/')`:
```typescript
const query = value.slice(1).toLowerCase()   // '/bt' → 'bt'
const matches = COMMANDS.filter(c =>
  query === '' || c.name.startsWith(query) || c.name.includes(query)
).slice(0, 6)
```

Dispatches `SET_SUGGESTIONS` on every input change when value starts with `/`.

### SuggestionOverlay component

New file `src/cli/tui/components/suggestion-overlay.tsx`.

Visual:
```
  /btw   旁路问题，不入主对话          <question>
▶ /bg    后台发送，不锁定输入          <message>
  /clear 清空消息流
──────────────────────────────────────────────
```

- Selected row: `inverse` (white bg, black text)
- Unselected: `dimColor`
- Right column (arg hint): `dimColor`
- Bottom separator line: `─`.repeat(columns)

Rendered in `app.tsx` **between MessageList and Editor**, `flexShrink={0}`. When `suggestions.length === 0` returns `null` (no space consumed).

Height = `suggestions.length` rows + 1 separator row. MessageList `visibleRows` is reduced by this height when overlay is showing.

### Keyboard handling

In `useTextInput`, when `value.startsWith('/')`:

- `↑` → `SUGGESTION_MOVE { delta: -1 }`
- `↓` → `SUGGESTION_MOVE { delta: +1 }`
- `Tab` or `→` (cursor at end) → complete selected command into input (`/btw ` with trailing space)
- `Esc` → `SUGGESTION_CLEAR` (close overlay, keep input)
- `Enter`:
  - If suggestion selected AND command has no args → execute handler immediately, clear input
  - If suggestion selected AND command has args → complete into input, wait for user to type args
  - If no suggestion selected → normal submit (existing behavior)

### Executing commands

Commands with no args (`/clear`, `/cost`, `/copy`, `/diff`, `/help`, `/quit`, `/new`) execute immediately on Enter.

Commands with required args (`/btw <q>`, `/bg <msg>`, `/session [id]`, `/model [name]`) complete the prefix into the input field and wait. User types the arg then presses Enter — the full `/btw question text` is sent to `sendMessage` which delegates to the command handler.

`sendMessage` in `app.tsx` checks if the message starts with a known command prefix before sending to the server:
```typescript
const command = COMMANDS.find(c => message.startsWith(c.prefix + ' ') || message === c.prefix)
if (command) {
  const args = message.slice(command.prefix.length).trim()
  command.handler(args, commandContext)
  return
}
// else: normal send to server
```

### State changes

`TuiState` adds:
```typescript
suggestions: TuiCommand[]
selectedSuggestion: number   // -1 = none
```

`TuiAction` adds:
```typescript
| { type: 'SET_SUGGESTIONS'; items: TuiCommand[]; selected: number }
| { type: 'SUGGESTION_MOVE'; delta: number }
| { type: 'SUGGESTION_CLEAR' }
```

---

## Part 5: `/btw` Modal

### State machine

```typescript
type BtwPhase =
  | { phase: 'idle' }
  | { phase: 'loading'; question: string; cancelFn: () => void }
  | { phase: 'showing'; question: string; content: string; scrollOffset: number }
```

`TuiState` adds:
```typescript
btwState: BtwPhase   // initial: { phase: 'idle' }
```

`TuiAction` adds:
```typescript
| { type: 'BTW_START'; question: string; cancelFn: () => void }
| { type: 'BTW_DELTA'; content: string }
| { type: 'BTW_DONE' }
| { type: 'BTW_CLOSE' }
| { type: 'BTW_SCROLL'; delta: number }
```

### Visual

New file `src/cli/tui/components/btw-modal.tsx`.

Loading state:
```
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  /btw  帮我解释这个报错
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  ∴ Thinking… ⠙
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
```

Showing state:
```
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  /btw  帮我解释这个报错
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  答案内容显示在这里，支持多行
  可以滚动查看更多内容。
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  ↑/↓ scroll  Esc close
```

- Border: `╌`.repeat(columns) (dashed feel, less heavy than `─`)
- Content area: `overflowY="hidden"` + `marginTop={-scrollOffset}`
- Max height: `Math.min(contentLines + 4, 14)` rows
- `flexShrink={0}`, inserted between MessageList and SuggestionOverlay in `app.tsx`

### Request mechanism

`/btw` command handler calls `streamChat()` with:
```typescript
streamChat({
  baseUrl: srv.baseUrl,
  message: question,
  sessionId: `btw-${crypto.randomUUID().slice(0, 8)}`,
  ephemeral: true,      // skip appendTurn on server
  onEvent: (event) => {
    if (event.kind === 'delta') dispatch({ type: 'BTW_DELTA', content: event.content })
  },
  onDone: () => dispatch({ type: 'BTW_DONE' }),
  onError: () => dispatch({ type: 'BTW_DONE' }),   // show partial content on error
})
```

The cancel function returned by `streamChat()` is stored in `btwState.cancelFn` and called on `BTW_CLOSE`.

### Keyboard during btw

`useTextInput` checks `btwState.phase !== 'idle'` before processing normal input:
- `↑` / `↓` → `BTW_SCROLL { delta: ±1 }`
- `Esc` → `BTW_CLOSE` (cancels request if loading)

Normal keyboard input (typing, Enter) is **not** blocked — user can continue composing a message while btw shows. Only `↑`/`↓`/`Esc` are intercepted.

`isRunning` is NOT set during btw — main conversation is fully available.

### Server: ephemeral support

`src/server/routes/stream.ts`:

```typescript
interface StreamBody {
  message: string
  sessionId?: string
  model?: string
  attachments?: ...
  ephemeral?: boolean   // new
}

// In handler:
if (!request.body.ephemeral) {
  await opts.strategy.appendTurn(sid, userMsg, assistantMsg)
}
```

`src/cli/tui/sse-client.ts` `StreamOptions` adds:
```typescript
ephemeral?: boolean
```

Body serialization includes it:
```typescript
const body = JSON.stringify({ message, sessionId, model, ephemeral, attachments... })
```

---

## Part 6: Session Continuity

### Auto-resume last session

**Last session file:** `~/.gemeniclaw/last-session` — single line containing the last used session ID. Written whenever TUI receives a valid `sessionId` from the server (the `onSessionId` callback).

**Startup logic** in `src/cli/commands/tui.ts`:
```typescript
.option('--new', 'Force new session (ignore last-session)')
.action(async (opts) => {
  let sessionId = opts.session  // explicit --session flag
  if (!sessionId && !opts.new) {
    try {
      sessionId = readFileSync(join(homedir(), '.gemeniclaw', 'last-session'), 'utf-8').trim() || undefined
    } catch { /* no last-session file */ }
  }
  await runTui({ model: opts.model, sessionId })
})
```

The `onSessionId` callback in `app.tsx` also writes the new session ID to `last-session`:
```typescript
onSessionId: (sid) => {
  dispatch({ type: 'SESSION_ID', id: sid })
  try { writeFileSync(join(homedir(), '.gemeniclaw', 'last-session'), sid) } catch {}
},
```

### History backfill on startup

When TUI starts with a `sessionId` (from `--session`, auto-resume, or `/session` command), it fetches recent history from the server:

```
GET /v1/sessions/{id}/messages?limit=30
```

Response messages are converted to `TuiEvent[]`:
- `role: 'user'` → `{ kind: 'user_message', content }`
- `role: 'assistant'` → `{ kind: 'response', content }`
- `role: 'tool'` → skip (keep UI clean)
- `role: 'system'` → skip

Dispatched via `LOAD_HISTORY` before the "Connected" system message, so history appears first in the scroll area.

**New action:**
```typescript
| { type: 'LOAD_HISTORY'; events: TuiEvent[] }
```

**Reducer:**
```typescript
case 'LOAD_HISTORY':
  return { ...state, events: [...action.events, ...state.events] }
```

Header briefly shows `↺ Loaded {n} messages` via a system event that auto-clears after 2s (implemented as a `setTimeout` dispatch in `app.tsx`).

### `/session` command handler

When user types `/session` (no args): fetch `GET /v1/sessions?limit=5`, display in message stream as a system event:

```
  Sessions:
  abc12345  2026-06-18  42 msgs  "帮我分析这个文件..."
  def67890  2026-06-17  18 msgs  "TUI 重构设计..."
  (type /session <id> to switch)
```

When user types `/session abc123`: 
1. Clear `state.events`
2. Fetch history from new session
3. Dispatch `LOAD_HISTORY`
4. Update `currentSessionId`
5. Write new ID to `~/.gemeniclaw/last-session`

### `/bg` command handler

`/bg <message>` sends the message to the server exactly like a normal message. The "background" behavior is purely client-side — the input is not locked during the request:

```typescript
// handler in handlers.ts
export function bgHandler(args: string, ctx: CommandContext) {
  if (!args.trim()) return
  ctx.dispatch({ type: 'BG_START' })
  // call streamChat normally, but dispatch BG_* actions instead of main actions
  streamChat({
    ...
    onEvent: (event) => {
      if (event.kind === 'delta') ctx.dispatch({ type: 'BG_DELTA', content: event.content })
    },
    onDone: () => ctx.dispatch({ type: 'BG_DONE' }),
  })
}
```

`TuiState` adds:
```typescript
bgRunning: boolean
bgContent: string   // accumulates background response
```

`TuiAction` adds:
```typescript
| { type: 'BG_START' }
| { type: 'BG_DELTA'; content: string }
| { type: 'BG_DONE' }
```

- `BG_START`: sets `bgRunning: true`, does NOT set `isRunning` (input stays unlocked)
- `BG_DONE`: sets `bgRunning: false`, appends `{ kind: 'response', content: bgContent }` to `state.events` with a `[bg]` prefix in the content
- Header shows `◎` when `bgRunning` (alongside or replacing the main `●`)

---

## File Map

### New files
- `src/cli/tui/commands/registry.ts` — command definitions + match logic
- `src/cli/tui/commands/handlers.ts` — command handler implementations
- `src/cli/tui/components/suggestion-overlay.tsx` — slash command suggestion dropdown
- `src/cli/tui/components/btw-modal.tsx` — /btw floating answer modal

### Modified files
- `src/cli/tui/components/message-item.tsx` — `turn_start` → `return null`
- `src/cli/tui/components/message-list.tsx` — margin-based scrolling, dispatch SET_MAX_SCROLL_OFFSET
- `src/cli/tui/components/editor.tsx` — two-row layout, StatusBar inline component, command detection
- `src/cli/tui/hooks/use-text-input.ts` — suggestion keyboard handling, btw scroll intercept
- `src/cli/tui/state.ts` — new fields: suggestions, selectedSuggestion, btwState, bgRunning, bgContent, maxScrollOffset
- `src/cli/tui/state.test.ts` — new reducer tests
- `src/cli/tui/types.ts` — no changes needed (existing kinds sufficient)
- `src/cli/tui/app.tsx` — SuggestionOverlay + BtwModal in layout, command routing in sendMessage, onSessionId writes last-session, history backfill on startup
- `src/cli/tui/sse-client.ts` — ephemeral field in StreamOptions + body
- `src/server/routes/stream.ts` — ephemeral param skips appendTurn
- `src/cli/commands/tui.ts` — --new flag, auto-resume from last-session

---

## What Is NOT Included

- `/session` list with fuzzy search UI (text list only in V1)
- `/model` implementation beyond completing prefix (model list fetch is V2)
- `/copy` on Linux/Windows (macOS `pbcopy` only in V1)
- `/diff` with syntax highlighting (plain text output in V1)
- Vim-style `/` search within message history
- `/bg` queue (only one background request at a time in V1)
- True per-item height measurement for scroll (1.5 row estimate in V1)
- Ctrl+R history search within input
