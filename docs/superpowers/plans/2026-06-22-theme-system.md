# Theme System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Space Anime Dark / Day Command / Deep Sea themes to the GeminiClaw web frontend via CSS custom properties and a sidebar theme switcher.

**Architecture:** Three `[data-theme]` CSS variable blocks on `:root`/`[data-theme]`; all React inline hex values replaced with `var(--gc-*)` tokens; generic Tailwind pages rewritten in space theme style; `saveTheme()`/`getTheme()` persist choice to localStorage; App.tsx passes `theme`+`setTheme` props to Sidebar.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind v4 (`@import "tailwindcss"`), CSS custom properties.

## Global Constraints

- `web/` frontend only — backend unchanged
- Space Anime Dark must be **visually identical** to current after refactor
- CRT scanline/vignette: use `opacity: var(--gc-crt-scanline)` / `opacity: var(--gc-crt-vignette)` on `body::before`/`body::after`; values are **binary** `1` (on) or `0` (off) — the gradients define the actual visual opacity internally
- `@import "tailwindcss"` must stay at line 1 of index.css (PostCSS ordering)
- No new npm dependencies

---

### Task 1: CSS Token Infrastructure

**Files:**
- Modify: `web/src/index.css` (full replacement)

**Interfaces:**
- Produces: `--gc-*` CSS custom properties consumed by all later tasks

- [ ] **Step 1: Replace web/src/index.css entirely**

Write the following as the complete new content of `web/src/index.css`:

```css
@import "tailwindcss";
@import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700&display=swap');

/* ═══════════════════════════════════════════════════════════════
   THEME TOKENS
   ─────────────────────────────────────────────────────────────
   :root / [data-theme="space-dark"]  — default; values identical to
   previous hardcoded hex values so Space Anime Dark is unchanged.
   ═══════════════════════════════════════════════════════════════ */

:root,
[data-theme="space-dark"] {
  --gc-bg:               #040810;
  --gc-panel:            #060d1a;
  --gc-panel-deep:       #030609;
  --gc-input-bg:         #030609;
  --gc-border:           #0d2a40;
  --gc-border-hi:        #0d3050;

  --gc-text:             #d4b870;
  --gc-text-dim:         #3d5060;
  --gc-text-label:       #7a5c20;
  --gc-text-mid:         #506070;

  --gc-accent:           #ff8c00;
  --gc-accent-dim:       #7a3c00;
  --gc-accent-glow:      rgba(255,140,0,0.25);

  --gc-accent2:          #00d4ff;
  --gc-accent2-dim:      #004455;
  --gc-accent2-glow:     rgba(0,212,255,0.2);

  --gc-green:            #00cc66;
  --gc-red:              #ff2200;
  --gc-error-glow:       rgba(255,68,0,0.6);
  --gc-error-bg:         #1a0500;
  --gc-error-border:     #661100;

  --gc-user-bg:          rgba(255,140,0,0.08);
  --gc-user-border:      #ff8c00;
  --gc-user-text:        #ff8c00;
  --gc-user-glow:        rgba(255,140,0,0.15);

  --gc-assistant-bg:     rgba(0,212,255,0.04);
  --gc-assistant-border: #0d3a4a;
  --gc-assistant-text:   #b0d0d8;
  --gc-assistant-glow:   rgba(0,212,255,0.08);

  --gc-sys-bg:           #060d1a;
  --gc-sys-border:       #0d2a40;
  --gc-sys-text:         #3d5060;

  --gc-grid-overlay:     rgba(13,42,64,0.3);

  /* CRT effects: 1 = on, 0 = off; opacity applied to body::before/after */
  --gc-crt-scanline:     1;
  --gc-crt-vignette:     1;
}

[data-theme="day-command"] {
  --gc-bg:               #e4eaf2;
  --gc-panel:            #d0dae6;
  --gc-panel-deep:       #c4d2e0;
  --gc-input-bg:         #f0f4f8;
  --gc-border:           #8aabcc;
  --gc-border-hi:        #5a7fa0;

  --gc-text:             #1a2a3a;
  --gc-text-dim:         #5a7090;
  --gc-text-label:       #3a5878;
  --gc-text-mid:         #3a5878;

  --gc-accent:           #c05808;
  --gc-accent-dim:       #7a380a;
  --gc-accent-glow:      rgba(192,88,8,0.15);

  --gc-accent2:          #0a6a8a;
  --gc-accent2-dim:      #08445a;
  --gc-accent2-glow:     rgba(10,106,138,0.15);

  --gc-green:            #1a8040;
  --gc-red:              #c02020;
  --gc-error-glow:       transparent;
  --gc-error-bg:         #fae0d8;
  --gc-error-border:     #c05030;

  --gc-user-bg:          rgba(192,88,8,0.08);
  --gc-user-border:      #c05808;
  --gc-user-text:        #8a3a04;
  --gc-user-glow:        rgba(192,88,8,0.12);

  --gc-assistant-bg:     rgba(10,106,138,0.06);
  --gc-assistant-border: #8aabcc;
  --gc-assistant-text:   #1a2a3a;
  --gc-assistant-glow:   rgba(10,106,138,0.12);

  --gc-sys-bg:           #d0dae6;
  --gc-sys-border:       #8aabcc;
  --gc-sys-text:         #5a7090;

  --gc-grid-overlay:     rgba(138,171,204,0.2);

  --gc-crt-scanline:     0;
  --gc-crt-vignette:     0;
}

[data-theme="deep-sea"] {
  --gc-bg:               #081420;
  --gc-panel:            #0c1c2c;
  --gc-panel-deep:       #060f18;
  --gc-input-bg:         #060f18;
  --gc-border:           #163048;
  --gc-border-hi:        #1e4060;

  --gc-text:             #c0d8e8;
  --gc-text-dim:         #3a6078;
  --gc-text-label:       #2a5068;
  --gc-text-mid:         #4a7090;

  --gc-accent:           #00b8d4;
  --gc-accent-dim:       #005868;
  --gc-accent-glow:      rgba(0,184,212,0.2);

  --gc-accent2:          #30c090;
  --gc-accent2-dim:      #185a40;
  --gc-accent2-glow:     rgba(48,192,144,0.2);

  --gc-green:            #30c090;
  --gc-red:              #e04040;
  --gc-error-glow:       rgba(224,64,64,0.5);
  --gc-error-bg:         #1a0808;
  --gc-error-border:     #601818;

  --gc-user-bg:          rgba(0,184,212,0.06);
  --gc-user-border:      #00b8d4;
  --gc-user-text:        #00b8d4;
  --gc-user-glow:        rgba(0,184,212,0.15);

  --gc-assistant-bg:     rgba(0,184,212,0.04);
  --gc-assistant-border: #1e4060;
  --gc-assistant-text:   #c0d8e8;
  --gc-assistant-glow:   rgba(0,184,212,0.08);

  --gc-sys-bg:           #0c1c2c;
  --gc-sys-border:       #163048;
  --gc-sys-text:         #2a5068;

  --gc-grid-overlay:     rgba(22,48,72,0.3);

  --gc-crt-scanline:     0;
  --gc-crt-vignette:     0;
}

/* ── Base ──────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; }

html, body, #root {
  height: 100%;
  margin: 0;
  padding: 0;
}

body {
  background: var(--gc-bg);
  color: var(--gc-text);
  font-family: 'Share Tech Mono', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
  overflow: hidden;
}

/* ── Scanline overlay ──────────────────────────────────────────── */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    transparent 0px,
    transparent 3px,
    rgba(0,0,0,0.12) 3px,
    rgba(0,0,0,0.12) 4px
  );
  pointer-events: none;
  z-index: 9998;
  opacity: var(--gc-crt-scanline);
}

/* CRT vignette */
body::after {
  content: '';
  position: fixed;
  inset: 0;
  background: radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.55) 100%);
  pointer-events: none;
  z-index: 9997;
  opacity: var(--gc-crt-vignette);
}

/* ── Panel ─────────────────────────────────────────────────────── */
.sp-panel {
  background: var(--gc-panel);
  border: 1px solid var(--gc-border);
  position: relative;
}
.sp-panel::before,
.sp-panel::after {
  content: '';
  position: absolute;
  width: 10px;
  height: 10px;
  border-color: var(--gc-accent);
  border-style: solid;
}
.sp-panel::before { top: -1px; left: -1px; border-width: 2px 0 0 2px; }
.sp-panel::after  { bottom: -1px; right: -1px; border-width: 0 2px 2px 0; }

/* ── Glows ─────────────────────────────────────────────────────── */
.glow-amber { box-shadow: 0 0 6px var(--gc-accent-glow), 0 0 12px var(--gc-accent-glow), inset 0 0 6px var(--gc-accent-glow); }
.glow-cyan  { box-shadow: 0 0 6px var(--gc-accent2-glow), 0 0 12px var(--gc-accent2-glow), inset 0 0 6px var(--gc-accent2-glow); }
.text-glow-amber { text-shadow: 0 0 8px var(--gc-accent-glow); }
.text-glow-cyan  { text-shadow: 0 0 8px var(--gc-accent2-glow); }
.text-glow-green { text-shadow: 0 0 8px var(--gc-accent2-glow); }

/* ── Animations ────────────────────────────────────────────────── */
@keyframes blink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}
@keyframes pulse-amber {
  0%, 100% { box-shadow: 0 0 4px var(--gc-accent-glow); }
  50%       { box-shadow: 0 0 12px var(--gc-accent-glow), 0 0 24px var(--gc-accent-glow); }
}
@keyframes scan-h {
  0%   { transform: translateY(-100%); opacity: 0; }
  10%  { opacity: 0.15; }
  90%  { opacity: 0.15; }
  100% { transform: translateY(100%); opacity: 0; }
}
@keyframes flicker {
  0%, 100% { opacity: 1; }
  92% { opacity: 1; }
  93% { opacity: 0.8; }
  94% { opacity: 1; }
  96% { opacity: 0.6; }
  97% { opacity: 1; }
}

.blink       { animation: blink 1.2s step-end infinite; }
.pulse-amber { animation: pulse-amber 2s ease-in-out infinite; }
.flicker     { animation: flicker 8s ease-in-out infinite; }

/* ── Section label ─────────────────────────────────────────────── */
.sp-label {
  font-size: 9px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--gc-text-label);
  border-bottom: 1px solid var(--gc-border);
  padding: 4px 12px;
}

/* ── Divider ───────────────────────────────────────────────────── */
.sp-divider {
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--gc-accent) 40%, var(--gc-accent) 60%, transparent);
  opacity: 0.4;
  margin: 0;
}

/* ── Scrollbar ─────────────────────────────────────────────────── */
::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: var(--gc-bg); }
::-webkit-scrollbar-thumb { background: var(--gc-border-hi); border-radius: 2px; }
::-webkit-scrollbar-thumb:hover { background: var(--gc-accent); }

/* ── Input ─────────────────────────────────────────────────────── */
.sp-input {
  background: var(--gc-input-bg);
  border: 1px solid var(--gc-border-hi);
  color: var(--gc-text);
  font-family: 'Share Tech Mono', monospace;
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.sp-input:focus {
  border-color: var(--gc-accent);
  box-shadow: 0 0 8px var(--gc-accent-glow), inset 0 0 4px var(--gc-accent-glow);
}
.sp-input::placeholder { color: var(--gc-text-dim); }

/* ── Button ────────────────────────────────────────────────────── */
.sp-btn {
  background: var(--gc-panel);
  border: 1px solid var(--gc-accent);
  color: var(--gc-accent);
  font-family: 'Share Tech Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 0.15s, box-shadow 0.15s;
  padding: 6px 14px;
}
.sp-btn:hover {
  background: var(--gc-accent);
  color: var(--gc-bg);
  box-shadow: 0 0 12px var(--gc-accent-glow);
}
.sp-btn:disabled { opacity: 0.3; cursor: not-allowed; }

.sp-btn-cyan { border-color: var(--gc-accent2); color: var(--gc-accent2); }
.sp-btn-cyan:hover {
  background: var(--gc-accent2);
  color: var(--gc-bg);
  box-shadow: 0 0 12px var(--gc-accent2-glow);
}

/* ── Nav item ──────────────────────────────────────────────────── */
.sp-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  font-size: 11px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--gc-text-dim);
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: all 0.15s;
  text-decoration: none;
  width: 100%;
  background: transparent;
  border-top: none; border-right: none; border-bottom: none;
}
.sp-nav-item:hover {
  color: var(--gc-text);
  background: var(--gc-accent-glow);
  border-left-color: var(--gc-accent-dim);
}
.sp-nav-item.active {
  color: var(--gc-accent);
  background: var(--gc-user-bg);
  border-left-color: var(--gc-accent);
  text-shadow: 0 0 8px var(--gc-accent-glow);
}

/* ── Markdown (prose-space) ────────────────────────────────────── */
.prose-space { color: var(--gc-assistant-text); line-height: 1.65; }
.prose-space > *:first-child { margin-top: 0; }
.prose-space > *:last-child  { margin-bottom: 0; }

.prose-space h1, .prose-space h2, .prose-space h3,
.prose-space h4, .prose-space h5, .prose-space h6 {
  font-family: 'Orbitron', monospace;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin: 14px 0 6px;
  color: var(--gc-accent);
  text-shadow: 0 0 8px var(--gc-accent-glow);
}
.prose-space h1 { font-size: 14px; border-bottom: 1px solid var(--gc-accent-dim); padding-bottom: 4px; }
.prose-space h2 { font-size: 13px; }
.prose-space h3 { font-size: 12px; color: var(--gc-text); text-shadow: none; }
.prose-space h4, .prose-space h5, .prose-space h6 { font-size: 11px; color: var(--gc-text-label); text-shadow: none; }
.prose-space p { margin: 6px 0; }

.prose-space code {
  background: var(--gc-assistant-bg);
  border: 1px solid var(--gc-accent2-dim);
  color: var(--gc-accent2);
  padding: 1px 5px;
  font-family: 'Share Tech Mono', monospace;
  font-size: 11px;
  text-shadow: 0 0 6px var(--gc-accent2-glow);
}
.prose-space pre {
  background: var(--gc-panel-deep);
  border: 1px solid var(--gc-border);
  border-left: 2px solid var(--gc-accent2);
  padding: 10px 12px;
  margin: 8px 0;
  overflow-x: auto;
  position: relative;
}
.prose-space pre::before {
  content: '// CODE';
  position: absolute;
  top: 4px; right: 8px;
  font-size: 8px;
  letter-spacing: 0.15em;
  color: var(--gc-accent2-dim);
}
.prose-space pre code {
  background: none; border: none; padding: 0;
  color: var(--gc-assistant-text); font-size: 12px; text-shadow: none;
}

.prose-space ul { list-style: none; padding-left: 4px; margin: 6px 0; }
.prose-space ul > li { padding-left: 14px; position: relative; margin: 3px 0; }
.prose-space ul > li::before { content: '▸'; position: absolute; left: 0; color: var(--gc-accent); }
.prose-space ol { padding-left: 20px; margin: 6px 0; counter-reset: sp-counter; list-style: none; }
.prose-space ol > li { position: relative; margin: 3px 0; counter-increment: sp-counter; padding-left: 4px; }
.prose-space ol > li::before { content: counter(sp-counter) '.'; position: absolute; left: -18px; color: var(--gc-accent); font-size: 11px; }

.prose-space strong { color: var(--gc-accent); font-weight: bold; }
.prose-space em { color: var(--gc-text); font-style: italic; }
.prose-space blockquote {
  border-left: 2px solid var(--gc-accent);
  margin: 8px 0; padding: 4px 10px;
  background: var(--gc-accent-glow);
  color: var(--gc-text-label);
}
.prose-space blockquote p { margin: 0; }
.prose-space hr {
  border: none; height: 1px;
  background: linear-gradient(90deg, transparent, var(--gc-accent) 30%, var(--gc-accent) 70%, transparent);
  opacity: 0.35; margin: 12px 0;
}
.prose-space a { color: var(--gc-accent2); text-decoration: none; border-bottom: 1px solid var(--gc-accent2-dim); }
.prose-space a:hover { color: var(--gc-accent); border-bottom-color: var(--gc-accent); }

.prose-space table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 12px; }
.prose-space th {
  background: var(--gc-user-bg);
  border: 1px solid var(--gc-border-hi);
  padding: 5px 10px;
  color: var(--gc-accent);
  font-size: 9px; letter-spacing: 0.15em; text-transform: uppercase; text-align: left;
}
.prose-space td { border: 1px solid var(--gc-border); padding: 5px 10px; color: var(--gc-assistant-text); }
.prose-space tr:nth-child(even) td { background: var(--gc-assistant-bg); }
```

- [ ] **Step 2: Verify Space Anime Dark is visually identical**

Open http://localhost:5173 (run `pnpm dev:web` from `web/src/index.css` parent if not running). The default theme is `space-dark` via `:root`. Check:
- Background is deep navy `#040810`
- Text is amber-gold `#d4b870`
- Buttons are amber bordered
- CRT scanlines are visible
- Vignette dark edges are present

If anything looks different, verify the `:root` token values match the old hardcoded values.

- [ ] **Step 3: Commit**

```bash
git add web/src/index.css
git commit -m "feat(web/css): three-theme CSS token infrastructure"
```

---

### Task 2: Theme Persistence + App Init

**Files:**
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/main.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Produces: `ThemeId`, `getTheme()`, `saveTheme()` for import by Sidebar (Task 3)
- Produces: `theme: ThemeId` + `setTheme: (id: ThemeId) => void` props expected by Sidebar

- [ ] **Step 1: Add theme functions to api.ts**

Append to the end of `web/src/lib/api.ts`:

```ts
// ── Theme ──────────────────────────────────────────────────────
export type ThemeId = 'space-dark' | 'day-command' | 'deep-sea'

export function getTheme(): ThemeId {
  return (localStorage.getItem('gc_theme') as ThemeId) ?? 'space-dark'
}

export function saveTheme(id: ThemeId): void {
  localStorage.setItem('gc_theme', id)
  document.documentElement.setAttribute('data-theme', id)
}
```

- [ ] **Step 2: Apply theme before first render in main.tsx**

Replace `web/src/main.tsx` with:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { saveTheme, getTheme } from './lib/api'
import './index.css'
import App from './App'

// Apply saved theme immediately — before React renders — to avoid flash
saveTheme(getTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 3: Update App.tsx**

Replace `web/src/App.tsx` with:

```tsx
import { useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import ChatPage from './pages/ChatPage'
import SessionsPage from './pages/SessionsPage'
import AgentsPage from './pages/AgentsPage'
import RunsPage from './pages/RunsPage'
import ConfigPage from './pages/ConfigPage'
import { getTheme, saveTheme, type ThemeId } from './lib/api'

export default function App() {
  const [theme, setTheme] = useState<ThemeId>(getTheme)

  const handleThemeChange = (id: ThemeId) => {
    saveTheme(id)
    setTheme(id)
  }

  return (
    <BrowserRouter>
      <div className="flex overflow-hidden" style={{ height: '100vh' }}>
        <Sidebar theme={theme} setTheme={handleThemeChange} />
        <main className="flex-1 overflow-hidden" style={{ position: 'relative' }}>
          <Routes>
            <Route path="/" element={<ChatPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/runs" element={<RunsPage />} />
            <Route path="/config" element={<ConfigPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
```

Note: the wrapper `div` no longer has `background: '#040810', color: '#d4b870'` — those now come from `body { background: var(--gc-bg); color: var(--gc-text); }` in CSS.

- [ ] **Step 4: Commit** (TypeScript will error on Sidebar props until Task 3)

```bash
git add web/src/lib/api.ts web/src/main.tsx web/src/App.tsx
git commit -m "feat(web): theme persistence — ThemeId, getTheme, saveTheme, App state"
```

---

### Task 3: Sidebar + Theme Switcher

**Files:**
- Modify: `web/src/components/Sidebar.tsx` (full replacement)

**Interfaces:**
- Consumes: `ThemeId` from `@/lib/api`
- Props: `{ theme: ThemeId; setTheme: (id: ThemeId) => void }`

- [ ] **Step 1: Replace Sidebar.tsx**

```tsx
import { NavLink } from 'react-router-dom'
import { MessageSquare, Clock, Cpu, Play, Settings } from 'lucide-react'
import type { ThemeId } from '@/lib/api'

const NAV = [
  { to: '/', icon: MessageSquare, label: 'Comm', code: 'SYS-01' },
  { to: '/sessions', icon: Clock, label: 'Log', code: 'SYS-02' },
  { to: '/agents', icon: Cpu, label: 'Units', code: 'SYS-03' },
  { to: '/runs', icon: Play, label: 'Ops', code: 'SYS-04' },
  { to: '/config', icon: Settings, label: 'Config', code: 'SYS-05' },
] as const

const THEMES: { id: ThemeId; color: string; label: string }[] = [
  { id: 'space-dark',  color: '#ff8c00', label: 'SPACE' },
  { id: 'day-command', color: '#c05808', label: 'DAY'   },
  { id: 'deep-sea',    color: '#00b8d4', label: 'SEA'   },
]

interface SidebarProps {
  theme: ThemeId
  setTheme: (id: ThemeId) => void
}

export default function Sidebar({ theme, setTheme }: SidebarProps) {
  return (
    <aside
      className="shrink-0 flex flex-col"
      style={{ width: '13rem', background: 'var(--gc-panel)', borderRight: '1px solid var(--gc-border)', position: 'relative' }}
    >
      <div style={{ height: '2px', background: 'linear-gradient(90deg, var(--gc-accent), var(--gc-accent-dim) 70%, transparent)' }} />

      <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid var(--gc-border)', position: 'relative' }}>
        <span style={{ position: 'absolute', top: 8, left: 8, width: 8, height: 8, borderTop: '1px solid var(--gc-accent)', borderLeft: '1px solid var(--gc-accent)' }} />
        <span style={{ position: 'absolute', top: 8, right: 8, width: 8, height: 8, borderTop: '1px solid var(--gc-accent)', borderRight: '1px solid var(--gc-accent)' }} />
        <div style={{ fontSize: 9, letterSpacing: '0.2em', color: 'var(--gc-text-label)', textTransform: 'uppercase', marginBottom: 4 }}>
          BATTLE SYSTEM
        </div>
        <div
          className="flicker"
          style={{ fontSize: 15, letterSpacing: '0.15em', color: 'var(--gc-accent)', fontWeight: 700, fontFamily: "'Orbitron', monospace", textShadow: '0 0 10px var(--gc-accent-glow)' }}
        >
          GEMINICLAW
        </div>
        <div style={{ fontSize: 9, color: 'var(--gc-text-dim)', letterSpacing: '0.1em', marginTop: 2 }}>
          AI-COMMAND / ONLINE
        </div>
        <span style={{ position: 'absolute', bottom: 8, left: 8, width: 8, height: 8, borderBottom: '1px solid var(--gc-accent)', borderLeft: '1px solid var(--gc-accent)' }} />
        <span style={{ position: 'absolute', bottom: 8, right: 8, width: 8, height: 8, borderBottom: '1px solid var(--gc-accent)', borderRight: '1px solid var(--gc-accent)' }} />
      </div>

      <div className="sp-label" style={{ marginTop: 8 }}>◈ SYSTEM COMMANDS</div>

      <nav style={{ flex: 1, padding: '4px 0' }}>
        {NAV.map(({ to, icon: Icon, label, code }) => (
          <NavLink key={to} to={to} end={to === '/'} style={{ textDecoration: 'none', display: 'block' }}>
            {({ isActive }) => (
              <div className={isActive ? 'sp-nav-item active' : 'sp-nav-item'} style={{ justifyContent: 'space-between' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <Icon size={13} />
                  {label}
                </span>
                <span style={{ fontSize: 9, opacity: isActive ? 0.8 : 0.3 }}>{code}</span>
              </div>
            )}
          </NavLink>
        ))}
      </nav>

      <div style={{ borderTop: '1px solid var(--gc-border)', padding: '8px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9, color: 'var(--gc-text-dim)', letterSpacing: '0.1em' }}>
          <span className="blink" style={{ color: 'var(--gc-green)', fontSize: 11 }}>●</span>
          TACTICAL NET ACTIVE
        </div>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          {THEMES.map(t => (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              title={t.label}
              style={{
                width: 12, height: 12,
                borderRadius: '50%',
                background: t.color,
                border: '1px solid transparent',
                outline: theme === t.id ? `2px solid ${t.color}` : 'none',
                outlineOffset: '1px',
                cursor: 'pointer',
                padding: 0,
                transition: 'outline 0.15s',
              }}
            />
          ))}
        </div>
      </div>

      <div style={{ position: 'absolute', right: 0, top: '20%', bottom: '20%', width: 1, background: 'linear-gradient(180deg, transparent, var(--gc-accent) 40%, var(--gc-accent) 60%, transparent)', opacity: 0.15 }} />
    </aside>
  )
}
```

- [ ] **Step 2: Verify theme switching works**

Open http://localhost:5173. At the bottom of the sidebar you should see 3 small color dots (amber / dark-orange / blue-green). Click each:
- Middle dot → background turns light blue-gray (Day Command), CRT effects disappear
- Right dot → background turns dark navy (Deep Sea), CRT effects disappear
- Left dot → Space Anime Dark returns with CRT effects

Reload the page — last selected theme persists.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/Sidebar.tsx
git commit -m "feat(web): sidebar theme switcher — 3 swatches, CSS vars applied"
```

---

### Task 4: ChatPage Inline Style Update

**Files:**
- Modify: `web/src/pages/ChatPage.tsx`

**Interfaces:**
- No new interfaces; replaces hardcoded hex with `var(--gc-*)`

- [ ] **Step 1: Apply color variable substitutions in ChatPage.tsx**

In `web/src/pages/ChatPage.tsx`, make the following replacements throughout the file. The logic, structure, and all non-color properties remain exactly the same.

**Simple substitutions (find → replace, all occurrences):**

| Find (exact string) | Replace with |
|---|---|
| `'#040810'` | `'var(--gc-bg)'` |
| `'#060d1a'` | `'var(--gc-panel)'` |
| `'#0d2a40'` | `'var(--gc-border)'` |
| `'1px solid #0d2a40'` | `'1px solid var(--gc-border)'` |
| `'#ff8c00'` | `'var(--gc-accent)'` |
| `'#7a3c00'` | `'var(--gc-accent-dim)'` |
| `'#00d4ff'` | `'var(--gc-accent2)'` |
| `'rgba(0,212,255,0.2)'` | `'var(--gc-accent2-glow)'` |
| `'#004455'` | `'var(--gc-accent2-dim)'` |
| `'#3d5060'` | `'var(--gc-text-dim)'` |
| `'#506070'` | `'var(--gc-text-mid)'` |
| `'#661100'` | `'var(--gc-error-border)'` |
| `'#ff4400'` | `'var(--gc-red)'` |
| `'rgba(255,140,0,0.08)'` | `'var(--gc-user-bg)'` |
| `'rgba(13,42,64,0.3)'` | `'var(--gc-grid-overlay)'` |
| `'rgba(255,68,0,0.6)'` | `'var(--gc-error-glow)'` |
| `'#1a0500'` | `'var(--gc-error-bg)'` |
| `'#1a3040'` | `'var(--gc-border-hi)'` |

**Gradient strings — replace color component only:**

```tsx
// Before:
'linear-gradient(90deg, #ff8c00 40%, transparent)'
// After:
'linear-gradient(90deg, var(--gc-accent) 40%, transparent)'

// Before:
'linear-gradient(90deg, transparent, rgba(255,140,0,0.4) 40%, rgba(255,140,0,0.4) 60%, transparent)'
// After:
'linear-gradient(90deg, transparent, var(--gc-accent-glow) 40%, var(--gc-accent-glow) 60%, transparent)'
```

**Conditional inline expressions — replace the color values inside:**

```tsx
// Session item active background:
// Before:  background: activeSessionId === s.id ? 'rgba(255,140,0,0.08)' : 'transparent'
// After:
background: activeSessionId === s.id ? 'var(--gc-user-bg)' : 'transparent'

// Session item border:
// Before:  borderLeft: `2px solid ${activeSessionId === s.id ? '#ff8c00' : 'transparent'}`
// After:
borderLeft: `2px solid ${activeSessionId === s.id ? 'var(--gc-accent)' : 'transparent'}`

// Session item icon color:
// Before:  color: activeSessionId === s.id ? '#ff8c00' : '#3d5060'
// After:
color: activeSessionId === s.id ? 'var(--gc-accent)' : 'var(--gc-text-dim)'

// Session item label color:
// Before:  color: activeSessionId === s.id ? '#ff8c00' : '#506070'
// After:
color: activeSessionId === s.id ? 'var(--gc-accent)' : 'var(--gc-text-mid)'

// Agent selector icon:
// Before:  color: selectedAgent ? '#00d4ff' : '#3d5060'
// After:
color: selectedAgent ? 'var(--gc-accent2)' : 'var(--gc-text-dim)'

// Agent selector box-shadow:
// Before:  boxShadow: selectedAgent ? '0 0 6px rgba(0,212,255,0.2)' : 'none'
// After:
boxShadow: selectedAgent ? '0 0 6px var(--gc-accent2-glow)' : 'none'
```

- [ ] **Step 2: Verify in all 3 themes**

Switch between the 3 themes on the Chat page:
- Session list items: active state uses theme's accent color
- Input field: focus glow uses theme's accent
- Auth warning banner: uses theme's error colors
- Background/panels: use theme colors

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/ChatPage.tsx
git commit -m "feat(web): ChatPage — replace inline hex with CSS vars"
```

---

### Task 5: MessageBubble + SessionList + ToolCallCard

**Files:**
- Modify: `web/src/components/MessageBubble.tsx` (full replacement)
- Modify: `web/src/components/SessionList.tsx` (full replacement)
- Modify: `web/src/components/ToolCallCard.tsx` (full replacement)

**Interfaces:**
- No new interfaces; components keep their existing props signatures unchanged

- [ ] **Step 1: Replace MessageBubble.tsx**

```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TuiEvent } from '@/lib/api'

interface MessageBubbleProps {
  event: TuiEvent & ({ kind: 'user_message' } | { kind: 'response' } | { kind: 'system' } | { kind: 'error' })
  streaming?: boolean
}

export default function MessageBubble({ event, streaming }: MessageBubbleProps) {
  if (event.kind === 'user_message') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <div style={{ maxWidth: '70%' }}>
          <div style={{ textAlign: 'right', fontSize: 9, letterSpacing: '0.15em', color: 'var(--gc-text-label)', marginBottom: 3, textTransform: 'uppercase' }}>
            ▶ OPERATOR INPUT
          </div>
          <div style={{
            background: 'var(--gc-user-bg)',
            border: '1px solid var(--gc-user-border)',
            borderTopRightRadius: 0,
            padding: '8px 12px',
            fontSize: 13,
            color: 'var(--gc-user-text)',
            lineHeight: 1.6,
            position: 'relative',
            boxShadow: '0 0 8px var(--gc-user-glow), inset 0 0 6px var(--gc-user-glow)',
          }}>
            {event.content}
            <span style={{ position: 'absolute', top: -1, right: -1, width: 6, height: 6, borderTop: '2px solid var(--gc-user-border)', borderRight: '2px solid var(--gc-user-border)' }} />
          </div>
        </div>
      </div>
    )
  }

  if (event.kind === 'response') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 16 }}>
        <div style={{ maxWidth: '80%' }}>
          <div style={{ fontSize: 9, letterSpacing: '0.15em', color: 'var(--gc-accent2-dim)', marginBottom: 3, textTransform: 'uppercase' }}>
            ◀ UNIT-GEMINI /{' '}
            {streaming
              ? <span className="blink" style={{ color: 'var(--gc-accent2)' }}>TRANSMITTING</span>
              : <span style={{ color: 'var(--gc-green)' }}>COMPLETE</span>
            }
          </div>
          <div style={{
            background: 'var(--gc-assistant-bg)',
            border: '1px solid var(--gc-assistant-border)',
            borderTopLeftRadius: 0,
            padding: '8px 12px',
            fontSize: 13,
            color: 'var(--gc-assistant-text)',
            lineHeight: 1.6,
            position: 'relative',
            boxShadow: '0 0 8px var(--gc-assistant-glow), inset 0 0 6px var(--gc-assistant-glow)',
          }}>
            {streaming ? (
              <span>
                {event.content}
                <span className="blink" style={{ display: 'inline-block', width: 8, height: 14, background: 'var(--gc-accent2)', marginLeft: 2, verticalAlign: 'middle', boxShadow: '0 0 6px var(--gc-accent2)' }} />
              </span>
            ) : (
              <div className="prose-space">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content}</ReactMarkdown>
              </div>
            )}
            <span style={{ position: 'absolute', bottom: -1, left: -1, width: 6, height: 6, borderBottom: '2px solid var(--gc-accent2)', borderLeft: '2px solid var(--gc-accent2)', opacity: 0.6 }} />
          </div>
        </div>
      </div>
    )
  }

  if (event.kind === 'system') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 9, letterSpacing: '0.15em', color: 'var(--gc-sys-text)', textTransform: 'uppercase', padding: '3px 12px', border: '1px solid var(--gc-sys-border)', background: 'var(--gc-sys-bg)' }}>
          ◈ SYS — {event.message}
        </div>
      </div>
    )
  }

  if (event.kind === 'error') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 9, letterSpacing: '0.15em', color: 'var(--gc-red)', textTransform: 'uppercase', padding: '3px 12px', border: '1px solid var(--gc-error-border)', background: 'var(--gc-error-bg)', textShadow: '0 0 6px var(--gc-error-glow)' }}>
          ⚠ ALERT — {event.message}
        </div>
      </div>
    )
  }

  return null
}
```

- [ ] **Step 2: Replace SessionList.tsx**

```tsx
import { MessageSquare, Plus } from 'lucide-react'

export interface SessionItem {
  id: string
  label: string
}

interface SessionListProps {
  sessions: SessionItem[]
  activeId: string | undefined
  onSelect: (id: string) => void
  onNew: () => void
}

export default function SessionList({ sessions, activeId, onSelect, onNew }: SessionListProps) {
  return (
    <aside style={{ width: '13rem', flexShrink: 0, display: 'flex', flexDirection: 'column', background: 'var(--gc-panel)', borderRight: '1px solid var(--gc-border)' }}>
      <div style={{ padding: '10px 10px 8px', borderBottom: '1px solid var(--gc-border)' }}>
        <button onClick={onNew} className="sp-btn" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <Plus size={11} />
          NEW SESSION
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {sessions.length === 0 && (
          <div style={{ fontSize: 9, color: 'var(--gc-text-dim)', textAlign: 'center', marginTop: 16, letterSpacing: '0.1em' }}>
            NO SESSIONS
          </div>
        )}
        {sessions.map(s => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              fontSize: 11,
              textAlign: 'left' as const,
              background: activeId === s.id ? 'var(--gc-user-bg)' : 'transparent',
              border: 'none',
              borderLeft: `2px solid ${activeId === s.id ? 'var(--gc-accent)' : 'transparent'}`,
              color: activeId === s.id ? 'var(--gc-accent)' : 'var(--gc-text-mid)',
              cursor: 'pointer',
              outline: 'none',
              fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}
          >
            <MessageSquare size={10} style={{ color: activeId === s.id ? 'var(--gc-accent)' : 'var(--gc-text-dim)', flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
          </button>
        ))}
      </div>
    </aside>
  )
}
```

- [ ] **Step 3: Replace ToolCallCard.tsx**

```tsx
import { useState } from 'react'
import { ChevronRight, ChevronDown, Wrench, CheckCircle, Loader } from 'lucide-react'

export interface ToolCallCardProps {
  name: string
  input?: unknown
  output?: unknown
  status: 'running' | 'done' | 'error'
}

export default function ToolCallCard({ name, input, output, status }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false)

  const statusColor =
    status === 'running' ? 'var(--gc-accent)' :
    status === 'done'    ? 'var(--gc-green)' :
                           'var(--gc-red)'

  return (
    <div style={{ margin: '6px 0', border: '1px solid var(--gc-border)', overflow: 'hidden', fontFamily: "'Share Tech Mono', monospace", fontSize: 11 }}>
      <button
        onClick={() => setExpanded(v => !v)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--gc-panel)', color: 'var(--gc-text)', textAlign: 'left', border: 'none', cursor: 'pointer' }}
      >
        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <Wrench size={10} style={{ color: 'var(--gc-accent2)', flexShrink: 0 }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--gc-text)' }}>{name}</span>
        {status === 'running' && <Loader size={10} style={{ color: 'var(--gc-accent)', animation: 'spin 1s linear infinite', flexShrink: 0 }} />}
        {status === 'done'    && <CheckCircle size={10} style={{ color: 'var(--gc-green)', flexShrink: 0 }} />}
        {status === 'error'   && <span style={{ color: 'var(--gc-red)', flexShrink: 0, fontSize: 10 }}>✗</span>}
      </button>
      {expanded && (
        <div style={{ display: 'grid', gridTemplateColumns: output !== undefined ? '1fr 1fr' : '1fr', borderTop: '1px solid var(--gc-border)' }}>
          <div style={{ padding: '8px 10px', background: 'var(--gc-panel-deep)', borderRight: output !== undefined ? '1px solid var(--gc-border)' : 'none' }}>
            <div style={{ fontSize: 8, letterSpacing: '0.15em', color: 'var(--gc-text-label)', textTransform: 'uppercase', marginBottom: 6 }}>Input</div>
            <pre style={{ margin: 0, color: 'var(--gc-assistant-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11 }}>
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
          {output !== undefined && (
            <div style={{ padding: '8px 10px', background: 'var(--gc-panel-deep)' }}>
              <div style={{ fontSize: 8, letterSpacing: '0.15em', color: 'var(--gc-text-label)', textTransform: 'uppercase', marginBottom: 6 }}>Output</div>
              <pre style={{ margin: 0, color: 'var(--gc-assistant-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11 }}>
                {typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Verify message rendering in all 3 themes**

Send a message in each theme and check:
- User bubble uses theme's accent color
- Assistant response uses assistant colors
- System/error messages render in theme colors
- ToolCallCard if visible uses theme colors

- [ ] **Step 5: Commit**

```bash
git add web/src/components/MessageBubble.tsx web/src/components/SessionList.tsx web/src/components/ToolCallCard.tsx
git commit -m "feat(web): MessageBubble + SessionList + ToolCallCard — CSS vars, space theme"
```

---

### Task 6: Pages — SessionsPage, AgentsPage, RunsPage, ConfigPage

**Files:**
- Modify: `web/src/pages/SessionsPage.tsx` (full replacement)
- Modify: `web/src/pages/AgentsPage.tsx` (full replacement)
- Modify: `web/src/pages/RunsPage.tsx` (full replacement)
- Modify: `web/src/pages/ConfigPage.tsx` (full replacement)

**Interfaces:**
- All existing props/logic retained; only styling changes

- [ ] **Step 1: Replace SessionsPage.tsx**

```tsx
import { useCallback, useEffect, useState } from 'react'
import { Trash2, RefreshCw } from 'lucide-react'
import { api, type Session } from '@/lib/api'

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setSessions(await api.getSessions())
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleDelete = async (id: string) => {
    await api.deleteSession(id)
    await load()
  }

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto', background: 'var(--gc-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontSize: 9, letterSpacing: '0.2em', color: 'var(--gc-text-label)', textTransform: 'uppercase' }}>◈ SESSION LOG</div>
        <button onClick={load} disabled={loading} className="sp-btn sp-btn-cyan" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={10} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          REFRESH
        </button>
      </div>

      <div style={{ border: '1px solid var(--gc-border)', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: "'Share Tech Mono', monospace" }}>
          <thead>
            <tr style={{ background: 'var(--gc-panel)' }}>
              {['Session ID', 'Title', 'Messages', 'Updated', ''].map(h => (
                <th key={h} style={{ padding: '6px 14px', textAlign: 'left', fontSize: 9, letterSpacing: '0.15em', color: 'var(--gc-text-label)', textTransform: 'uppercase', borderBottom: '1px solid var(--gc-border)', fontWeight: 'normal' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--gc-text-dim)', fontSize: 9, letterSpacing: '0.1em' }}>LOADING…</td></tr>
            )}
            {!loading && sessions.length === 0 && (
              <tr><td colSpan={5} style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--gc-text-dim)', fontSize: 9, letterSpacing: '0.1em' }}>NO SESSIONS</td></tr>
            )}
            {sessions.map(s => (
              <tr key={s.id} style={{ borderBottom: '1px solid var(--gc-border)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-user-bg)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ padding: '8px 14px', color: 'var(--gc-text-dim)', fontSize: 10 }}>{s.id.slice(0, 8)}…</td>
                <td style={{ padding: '8px 14px', color: 'var(--gc-text)' }}>{s.title ?? '(untitled)'}</td>
                <td style={{ padding: '8px 14px', color: 'var(--gc-text-mid)' }}>{s.message_count ?? '—'}</td>
                <td style={{ padding: '8px 14px', color: 'var(--gc-text-dim)', fontSize: 10 }}>{new Date(s.updated_at).toLocaleString()}</td>
                <td style={{ padding: '8px 14px' }}>
                  <button onClick={() => handleDelete(s.id)} title="Delete session"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gc-text-dim)', padding: 0, transition: 'color 0.15s' }}
                    onMouseEnter={e => (e.currentTarget.style.color = 'var(--gc-red)')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--gc-text-dim)')}
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Replace AgentsPage.tsx**

```tsx
import { useEffect, useState } from 'react'
import { Cpu, RefreshCw } from 'lucide-react'
import { api, type Agent } from '@/lib/api'

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    setAgents(await api.getAgents())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const statusColor = (status: string) =>
    status === 'active' ? 'var(--gc-green)' :
    status === 'idle'   ? 'var(--gc-text-dim)' :
                          'var(--gc-text-dim)'

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto', background: 'var(--gc-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontSize: 9, letterSpacing: '0.2em', color: 'var(--gc-text-label)', textTransform: 'uppercase' }}>◈ UNIT REGISTRY</div>
        <button onClick={load} disabled={loading} className="sp-btn sp-btn-cyan" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={10} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          REFRESH
        </button>
      </div>

      {loading && <div style={{ fontSize: 9, color: 'var(--gc-text-dim)', letterSpacing: '0.1em' }}>LOADING…</div>}

      {!loading && agents.length === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 60, color: 'var(--gc-text-dim)' }}>
          <Cpu size={32} style={{ marginBottom: 12, opacity: 0.3 }} />
          <div style={{ fontSize: 9, letterSpacing: '0.15em', textTransform: 'uppercase' }}>NO UNITS ACTIVE</div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
        {agents.map(a => (
          <div key={a.id} style={{ background: 'var(--gc-panel)', border: '1px solid var(--gc-border)', padding: 14, position: 'relative', transition: 'border-color 0.15s' }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--gc-border-hi)')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <Cpu size={14} style={{ color: 'var(--gc-accent2)', flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--gc-text)', fontFamily: "'Share Tech Mono', monospace" }}>{a.name}</span>
              <span style={{ fontSize: 8, letterSpacing: '0.1em', textTransform: 'uppercase', color: statusColor(a.status), border: `1px solid ${statusColor(a.status)}`, padding: '1px 6px', flexShrink: 0 }}>
                {a.status}
              </span>
            </div>
            {a.lastActive && (
              <div style={{ fontSize: 9, color: 'var(--gc-text-dim)', paddingLeft: 24, letterSpacing: '0.05em' }}>
                {new Date(a.lastActive).toLocaleString()}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Replace RunsPage.tsx**

```tsx
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api, type Run } from '@/lib/api'

export default function RunsPage() {
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    setRuns(await api.getRuns())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const statusColor = (s: string) =>
    s === 'completed' ? 'var(--gc-green)' :
    s === 'running'   ? 'var(--gc-accent)' :
    s === 'failed'    ? 'var(--gc-red)' :
                        'var(--gc-text-dim)'

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto', background: 'var(--gc-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontSize: 9, letterSpacing: '0.2em', color: 'var(--gc-text-label)', textTransform: 'uppercase' }}>◈ OPERATION HISTORY</div>
        <button onClick={load} disabled={loading} className="sp-btn sp-btn-cyan" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={10} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          REFRESH
        </button>
      </div>

      <div style={{ border: '1px solid var(--gc-border)', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: "'Share Tech Mono', monospace" }}>
          <thead>
            <tr style={{ background: 'var(--gc-panel)' }}>
              {['Run ID', 'Status', 'Duration', 'Created'].map(h => (
                <th key={h} style={{ padding: '6px 14px', textAlign: 'left', fontSize: 9, letterSpacing: '0.15em', color: 'var(--gc-text-label)', textTransform: 'uppercase', borderBottom: '1px solid var(--gc-border)', fontWeight: 'normal' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={4} style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--gc-text-dim)', fontSize: 9, letterSpacing: '0.1em' }}>LOADING…</td></tr>
            )}
            {!loading && runs.length === 0 && (
              <tr><td colSpan={4} style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--gc-text-dim)', fontSize: 9, letterSpacing: '0.1em' }}>NO RUNS</td></tr>
            )}
            {runs.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid var(--gc-border)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-user-bg)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ padding: '8px 14px', color: 'var(--gc-text-dim)', fontSize: 10 }}>{r.id.slice(0, 12)}…</td>
                <td style={{ padding: '8px 14px' }}>
                  <span style={{ fontSize: 8, letterSpacing: '0.1em', textTransform: 'uppercase', color: statusColor(r.status), border: `1px solid ${statusColor(r.status)}`, padding: '1px 6px' }}>
                    {r.status}
                  </span>
                </td>
                <td style={{ padding: '8px 14px', color: 'var(--gc-text-mid)', fontSize: 10 }}>
                  {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}
                </td>
                <td style={{ padding: '8px 14px', color: 'var(--gc-text-dim)', fontSize: 10 }}>
                  {new Date(r.createdAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Replace ConfigPage.tsx**

```tsx
import { useState } from 'react'
import { Save, CheckCircle } from 'lucide-react'
import { getConfig, saveConfig } from '@/lib/api'

export default function ConfigPage() {
  const [config, setConfig] = useState(getConfig)
  const [saved, setSaved] = useState(false)

  const handleSave = () => {
    saveConfig(config)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto', background: 'var(--gc-bg)' }}>
      <div style={{ fontSize: 9, letterSpacing: '0.2em', color: 'var(--gc-text-label)', textTransform: 'uppercase', marginBottom: 20 }}>
        ◈ SYSTEM CONFIG
      </div>

      <div style={{ maxWidth: 480 }}>
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontSize: 9, letterSpacing: '0.15em', color: 'var(--gc-text-dim)', textTransform: 'uppercase', marginBottom: 8 }}>
            Auth Token
          </label>
          <input
            type="password"
            value={config.authToken}
            onChange={e => setConfig(c => ({ ...c, authToken: e.target.value }))}
            placeholder="optional"
            className="sp-input"
            style={{ width: '100%', padding: '8px 12px' }}
          />
          <p style={{ marginTop: 6, fontSize: 9, color: 'var(--gc-text-dim)', letterSpacing: '0.08em' }}>
            Sent as Authorization: Bearer &lt;token&gt;
          </p>
        </div>

        <button onClick={handleSave} className="sp-btn" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {saved ? <CheckCircle size={12} /> : <Save size={12} />}
          {saved ? 'SAVED' : 'SAVE CHANGES'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Full verification across all 3 themes**

Open http://localhost:5173, cycle through all 3 themes using the sidebar swatches, and visit every page:

| Page | Things to check |
|---|---|
| `/` Chat | Session list, input, messages, auth banner |
| `/sessions` | Table, refresh button, delete button color on hover |
| `/agents` | Agent cards, status badges, empty state |
| `/runs` | Table, status badge colors |
| `/config` | Input field, save button |

In Day Command: background should be light blue-gray, text dark navy, no CRT effects.  
In Deep Sea: background dark blue (not black), text light blue-gray, no CRT effects.  
In Space Anime: identical to before — amber, CRT on, gold text.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/SessionsPage.tsx web/src/pages/AgentsPage.tsx web/src/pages/RunsPage.tsx web/src/pages/ConfigPage.tsx
git commit -m "feat(web): pages — space-themed SessionsPage, AgentsPage, RunsPage, ConfigPage"
```
