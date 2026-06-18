# Browser Tool Redesign Spec

**Date:** 2026-06-18  
**Status:** Approved for implementation  
**Replaces:** `src/tools/browser.ts`

## Goal

Replace the single monolithic `browser` tool (8 actions via a routing parameter) with a family of 11 independent, single-purpose tools. Add accessibility-tree-based page representation with element refs, Set-of-Marks screenshot annotation, two-tier element location fallback, and automatic dialog handling.

## Background

The existing `browser` tool works but has three problems:

1. **Coarse tool schema** — LLM must guess the right `action` string; all 8 actions share one description, making tool selection less accurate.
2. **No structured page representation** — only raw text extraction; no element refs for stable targeting.
3. **No graceful fallback** — CSS selector failures return an error with no recovery path.

Reference implementations studied: hermes-agent `browser_tool.py` (aria tree + refs), autogen `page_script.js` + `_set_of_mark.py` (SOM annotation), mastra `agent-browser` (Zod schemas + ref-based tools).

---

## Architecture

### File Structure

```
src/tools/browser/
├── session.ts      # BrowserSession singleton — puppeteer Page lifecycle
├── snapshot.ts     # aria tree → compact/full text, ref assignment
├── som.ts          # Set-of-Marks: annotate screenshot with element ref boxes
├── dialog.ts       # Injected script intercepting alert/confirm/prompt
├── tools.ts        # All browser_* tool registrations
└── index.ts        # re-export, replaces old browser.ts import
```

`src/tools/browser.ts` is deleted. `src/tools/index.ts` imports `./browser/index.js` instead.

### Dependency Flow

```
tools.ts
  ├── session.ts        shared puppeteer Page, refMap, liveness watchdog
  ├── snapshot.ts       aria tree extraction, compact/full modes
  ├── som.ts            screenshot + rect overlay
  └── dialog.ts         evaluateOnNewDocument injection
```

### BrowserSession (`session.ts`)

A module-level singleton per `sessionId` string (default `'default'`). Holds:

- `browser`: `puppeteer.Browser | null`  
- `pages`: `Map<string, puppeteer.Page>`  
- `refMap`: `Map<string, RefEntry>` — maps `'e5'` → `{ role, name, selector, ariaNodeId }`

**`getPage(sessionId?)`** — returns existing Page or creates one. On first creation:
1. Sets user-agent and viewport
2. Calls `injectDialogScript(page)` from `dialog.ts`
3. Registers `page.on('dialog', d => d.dismiss())` as fallback

**`getOrLaunchBrowser()`** — checks `BROWSER_CDP_URL` env first (`puppeteer.connect`), otherwise `puppeteer.launch` with system Chrome path. Preserves existing liveness CPU watchdog logic.

**`withLiveness(promise, label)`** — unchanged from current implementation, moved here.

**`rebuildRefs(page, nodes)`** — called by `snapshot.ts` after each aria tree extraction. Clears and repopulates `refMap`.

---

## Tool Definitions

All tools registered via `registry.register(...)` in `tools.ts`. All have `toolset: ['default']`, `requiresApproval: false`, `executionMode: 'sequential'`.

### `browser_navigate`

Navigate to a URL. Returns compact snapshot automatically (no extra round-trip needed).

**Parameters:**
```typescript
{
  url: string,                              // required
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0',  // default: 'domcontentloaded'
  waitFor?: string,                         // CSS selector to wait for after load
  session?: string                          // default: 'default'
}
```

**Returns:** `{ url, title, snapshot: compactSnapshotText, dialogs?: DialogEntry[] }`

**Flow:**
1. `page.goto(url, { waitUntil, timeout: 30000 })`
2. If `waitFor`: `page.waitForSelector(waitFor, { timeout: 5000 }).catch(() => {})`
3. `snapshotCompact(page, session)` → rebuild refs, format text
4. Collect and clear `window.__pendingDialogs`
5. Return combined result

Blocks private IPs / cloud metadata endpoints (same SSRF guard as current implementation).

---

### `browser_snapshot`

Get the current page's accessibility tree.

**Parameters:**
```typescript
{
  mode?: 'compact' | 'full',   // default: 'compact'
  session?: string
}
```

**Returns:** `{ url, title, snapshot: string, refCount: number }`

**Compact mode:** Interactive nodes only (button, link, textbox, checkbox, radio, combobox, menuitem, tab, searchbox, landmark headings). Assigns/rebuilds refs. Typical output: 300–800 tokens.

**Full mode:** Complete aria tree. Truncated at 12,000 chars at section boundaries (never mid-node). Appends `[Truncated — use browser_scroll to see more]` if cut.

**Format (compact):**
```
[Page: "GitHub — repo"]
[URL: https://...]

## nav
- link "Pull requests" [e1]
- link "Issues" [e2]

## main
- heading "GeminiClaw"
- button "Star" [e3]
- textbox "Search or jump to..." [e4]
```

---

### `browser_click`

Click an interactive element. Two-tier fallback built in.

**Parameters:**
```typescript
{
  ref?: string,        // e.g. "e5" — from snapshot refs
  selector?: string,   // CSS selector fallback
  session?: string
}
```

Must provide at least one of `ref` or `selector`.

**Flow:**
1. **Tier 1 — ref:** Look up `refMap[ref]`. Use `ariaNodeId` to locate via `page.accessibility` or stored `selector`. `page.click(resolvedSelector)`.
2. **Tier 2 — selector:** `page.waitForSelector(selector, { timeout: 5000 })` then `page.click(selector)`.
3. **Tier 3 — both failed:** Rebuild refs via `snapshotCompact`, then take annotated screenshot (SOM). Return `{ success: false, error: 'Element not found', screenshot: base64, refs: visibleRefs }`. Agent sees the current page with up-to-date refs and can retry.

After successful click: wait for navigation if it occurs (500ms `waitForNavigation` timeout, non-fatal).

**Returns (success):** `{ success: true, dialogs?: DialogEntry[] }`  
**Returns (failure):** `{ success: false, error: string, screenshot?: base64, refs?: string[] }`

---

### `browser_type`

Type text into an input field. Same two-tier ref/selector fallback as `browser_click`.

**Parameters:**
```typescript
{
  ref?: string,
  selector?: string,
  text: string,
  clearFirst?: boolean,   // default: true — clears existing value before typing
  session?: string
}
```

**Flow:**
1. Locate element (same tier 1/2 fallback as click)
2. If `clearFirst`: `page.click(sel)` then `page.keyboard.down('Control')` + `'a'` + `page.keyboard.up('Control')` + `page.keyboard.press('Backspace')`
3. `page.type(sel, text, { delay: 20 })`

**Returns:** `{ success: true }` or tier-3 fallback screenshot.

---

### `browser_scroll`

Scroll the page or a scrollable element.

**Parameters:**
```typescript
{
  direction: 'up' | 'down' | 'left' | 'right',
  amount?: number,     // pixels, default: 500
  ref?: string,        // scroll a specific element instead of window
  session?: string
}
```

Uses `page.evaluate` to call `window.scrollBy` or `element.scrollBy`.

**Returns:** `{ scrolled: true }`

---

### `browser_press`

Press a keyboard key.

**Parameters:**
```typescript
{
  key: string,    // Puppeteer KeyInput: 'Enter', 'Tab', 'Escape', 'ArrowDown', etc.
  session?: string
}
```

**Returns:** `{ pressed: key }`

---

### `browser_screenshot`

Take a screenshot of the current page.

**Parameters:**
```typescript
{
  annotate?: boolean,   // default: false — if true, overlays SOM element boxes
  session?: string
}
```

**Returns (no annotate):** multimodal result `{ type: 'multimodal', content: [image], textSummary: '[Screenshot: title, WxH]' }`

**Returns (annotate):** multimodal result with annotated PNG + text ref list:
```
[Screenshot with 9 interactive elements marked]
Visible: e1(button "Sign in"), e3(link "Explore"), e5(textbox "Search GitHub")
```

---

### `browser_eval`

Execute JavaScript in the page context.

**Parameters:**
```typescript
{
  js: string,     // expression (not statement — must return a value)
  session?: string
}
```

**Returns:** `{ result: string }` — JSON-stringified if object, String() otherwise.

Implementation wraps `js` as `new Function(js)` so both expressions (`document.title`) and statements (`const x = 1; return x`) are valid. Uses `withLiveness(page.evaluate(...), label, { stallSeconds: 45 })`.

---

### `browser_back`

Navigate back in browser history.

**Parameters:** `{ session?: string }`

**Returns:** `{ url, title, snapshot: compactSnapshotText }` — also rebuilds refMap for the new page.

---

### `browser_wait`

Wait for a condition before proceeding.

**Parameters:**
```typescript
{
  selector?: string,   // wait for element to appear
  ms?: number,         // wait fixed milliseconds (default: 1000 if no selector)
  session?: string
}
```

If `selector` provided: `page.waitForSelector(selector, { timeout: 10000 })`.  
Otherwise: `new Promise(r => setTimeout(r, ms))`.

**Returns:** `{ waited: true, appeared?: boolean }`

---

### `browser_close`

Close a browser session (page + browser if no other pages).

**Parameters:** `{ session?: string }`

**Returns:** `{ closed: session }`

---

## Snapshot Module (`snapshot.ts`)

### `snapshotCompact(page, sessionId): Promise<string>`

1. `page.accessibility.snapshot({ interestingOnly: true })` — Puppeteer built-in, returns aria tree
2. Walk the tree, collect nodes where `role` ∈ interactive set or node is a named landmark
3. Assign refs sequentially: `e1`, `e2`, … Store in `session.refMap`
4. Format into section-grouped text (group by landmark ancestor)
5. Return formatted string

### `snapshotFull(page, sessionId): Promise<string>`

1. `page.accessibility.snapshot({ interestingOnly: false })`
2. Walk entire tree, format with indentation
3. If output > 12,000 chars: find last section boundary before limit, truncate there, append truncation notice

### Interactive Role Set

```typescript
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio',
  'combobox', 'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'tab', 'searchbox', 'switch', 'slider', 'spinbutton',
  'treeitem', 'gridcell'
])
```

---

## SOM Module (`som.ts`)

### `annotateScreenshot(page, sessionId): Promise<AnnotatedResult>`

1. `page.screenshot({ type: 'png', fullPage: false })` → raw Buffer
2. `page.evaluate(getInteractiveRectsJS)` → `Map<refId, DOMRect>`
   - `getInteractiveRectsJS`: inline JS matching session's `refMap` entries to their current `getBoundingClientRect()`
3. For each visible rect (top ≥ 0, bottom ≤ viewportHeight):
   - Draw semi-transparent filled box (color seeded from ref number)
   - Draw `refId` label at top-right corner, white text on dark bg or black on light
4. Encode annotated PNG to base64
5. Return `{ base64, visibleRefs: string[], rectsAbove: string[], rectsBelow: string[] }`

**Dependency:** `@napi-rs/canvas` (pure Node.js Canvas, no system libcairo required, already in puppeteer-core's optional deps chain). If unavailable, fall back to unannotated screenshot.

---

## Dialog Module (`dialog.ts`)

### `injectDialogScript(page): Promise<void>`

```typescript
await page.evaluateOnNewDocument(() => {
  window.__pendingDialogs = []
  window.alert   = (msg) => { window.__pendingDialogs.push({ type: 'alert',   msg }) }
  window.confirm = (msg) => { window.__pendingDialogs.push({ type: 'confirm', msg }); return true }
  window.prompt  = (msg, def) => { window.__pendingDialogs.push({ type: 'prompt', msg }); return def ?? '' }
})
```

### `collectDialogs(page): Promise<DialogEntry[]>`

```typescript
const dialogs = await page.evaluate(() => {
  const d = window.__pendingDialogs ?? []
  window.__pendingDialogs = []
  return d
})
return dialogs
```

Called at the end of `navigate`, `click` (after navigation), `back`.

### Native Dialog Fallback

```typescript
page.on('dialog', async (dialog) => {
  await dialog.dismiss()
})
```

Registered in `getPage()`. Handles `window.open`-triggered native dialogs that bypass the injection.

---

## Error Handling

| Scenario | Behavior | Agent receives |
|----------|----------|---------------|
| Element not found (both tiers fail) | Annotated screenshot | `{ success: false, error, screenshot, refs }` |
| Navigation timeout (30s) | Cancel, return current state | Current URL + compact snapshot |
| Page crash / disconnected | Rebuild Page, clear refMap | `"Browser crashed, new page ready"` |
| JS eval exception | Catch, return error | Error message + first stack line |
| Private IP / metadata endpoint | Block before navigate | `"Blocked: private address"` |
| Chrome process dies | `_browser = null` | Next call relaunches silently |
| aria snapshot empty | Return `"[Page appears empty or not fully loaded]"` | Suggestion to use `browser_wait` |
| SOM canvas dependency missing | Return unannotated screenshot | Screenshot without boxes, no error |

---

## Migration

- `src/tools/browser.ts` → deleted
- `src/tools/index.ts` line: `import './browser.js'` → `import './browser/index.js'`
- No changes to `src/agent/loop.ts` — multimodal tool result format unchanged
- Existing `toolset: ['default']` means all 11 tools are available in default agent sessions
- `BROWSER_PATH` env var still honored for Chrome executable path
- New env var: `BROWSER_CDP_URL` — if set, `connect()` to existing Chrome instead of `launch()`

---

## Dependencies

| Package | Already present | Notes |
|---------|----------------|-------|
| `puppeteer-core` | ✓ | Existing dep |
| `@napi-rs/canvas` | ✗ | Add for SOM annotation; graceful fallback if absent |

Only one new dependency. `@napi-rs/canvas` is preferred over `canvas` (no system libcairo) or `sharp` (image manipulation only, no drawing).

---

## What Is NOT Included

- Persistent CDP Supervisor / WebSocket session (hermes pattern) — not needed for headless automation
- Cloud browser backends (Browserbase, Browser Use) — out of scope
- Multi-backend routing / Lightpanda fallback — out of scope
- `browser_hover` — can be added later; not needed for core automation
- File upload — can be added later
- Video/screencast — out of scope
