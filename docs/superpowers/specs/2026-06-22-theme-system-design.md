# Theme System Design

**Date:** 2026-06-22  
**Scope:** `web/` — React frontend only  
**Goal:** Add 2 new UI themes (Day Command, Deep Sea) alongside the existing Space Anime Dark, with a sidebar theme switcher.

---

## Summary

Replace all hardcoded hex colors in the web frontend with CSS custom properties. Define three theme palettes via `[data-theme]` on the root element. Add a 3-button theme picker to the sidebar. The Space Anime Dark theme must be visually identical to the current implementation.

---

## Architecture

### Mechanism

- `document.documentElement.setAttribute('data-theme', id)` switches themes
- Each theme is a CSS block: `[data-theme="space-dark"] { --gc-bg: ...; ... }`
- All components reference `var(--gc-*)` tokens — never literal hex values
- Theme preference persisted to `localStorage` key `gc_theme`, default `space-dark`
- No React context required; theme switching is pure CSS

### Token Set

All three themes define the same variable names:

```css
/* Backgrounds */
--gc-bg            /* main app background */
--gc-panel         /* sidebar / panel background */
--gc-panel-deep    /* deep panels, code blocks */
--gc-input-bg      /* input field background */

/* Borders */
--gc-border        /* primary border */
--gc-border-hi     /* highlighted / focus border */

/* Text */
--gc-text          /* primary text */
--gc-text-dim      /* muted / secondary text */
--gc-text-label    /* section labels, fine print */
--gc-text-mid      /* mid-tone text */

/* Accent 1 (primary) */
--gc-accent        /* primary accent */
--gc-accent-dim    /* dimmed primary accent */
--gc-accent-glow   /* glow rgba string */

/* Accent 2 (secondary) */
--gc-accent2       /* secondary accent */
--gc-accent2-dim
--gc-accent2-glow

/* Status */
--gc-green
--gc-red
--gc-error-bg      /* error notification background */
--gc-error-border

/* Message bubbles */
--gc-user-bg       /* user message bubble background */
--gc-user-border
--gc-user-text
--gc-sys-border    /* system/error event border */
--gc-sys-text

/* CRT effects (set to 0 to disable) */
--gc-crt-scanline   /* scanline layer opacity */
--gc-crt-vignette   /* vignette layer opacity */
```

---

## Theme Palettes

### space-dark — Space Anime Dark (current, unchanged)

```css
[data-theme="space-dark"] {
  --gc-bg:            #040810;
  --gc-panel:         #060d1a;
  --gc-panel-deep:    #030609;
  --gc-input-bg:      #030609;
  --gc-border:        #0d2a40;
  --gc-border-hi:     #0d3050;

  --gc-text:          #d4b870;
  --gc-text-dim:      #3d5060;
  --gc-text-label:    #7a5c20;
  --gc-text-mid:      #506070;

  --gc-accent:        #ff8c00;
  --gc-accent-dim:    #7a3c00;
  --gc-accent-glow:   rgba(255,140,0,0.25);

  --gc-accent2:       #00d4ff;
  --gc-accent2-dim:   #004455;
  --gc-accent2-glow:  rgba(0,212,255,0.2);

  --gc-green:         #00cc66;
  --gc-red:           #ff2200;
  --gc-error-bg:      #1a0500;
  --gc-error-border:  #661100;

  --gc-user-bg:       rgba(255,140,0,0.08);
  --gc-user-border:   #ff8c00;
  --gc-user-text:     #ff8c00;
  --gc-sys-border:    #0d2a40;
  --gc-sys-text:      #3d5060;

  --gc-crt-scanline:  0.12;
  --gc-crt-vignette:  0.55;
}
```

### day-command — Day Command (light, readable in bright environments)

```css
[data-theme="day-command"] {
  --gc-bg:            #e4eaf2;
  --gc-panel:         #d0dae6;
  --gc-panel-deep:    #c4d2e0;
  --gc-input-bg:      #f0f4f8;
  --gc-border:        #8aabcc;
  --gc-border-hi:     #5a7fa0;

  --gc-text:          #1a2a3a;
  --gc-text-dim:      #5a7090;
  --gc-text-label:    #3a5878;
  --gc-text-mid:      #3a5878;

  --gc-accent:        #c05808;
  --gc-accent-dim:    #7a380a;
  --gc-accent-glow:   rgba(192,88,8,0.15);

  --gc-accent2:       #0a6a8a;
  --gc-accent2-dim:   #08445a;
  --gc-accent2-glow:  rgba(10,106,138,0.15);

  --gc-green:         #1a8040;
  --gc-red:           #c02020;
  --gc-error-bg:      #fae0d8;
  --gc-error-border:  #c05030;

  --gc-user-bg:       rgba(192,88,8,0.08);
  --gc-user-border:   #c05808;
  --gc-user-text:     #8a3a04;
  --gc-sys-border:    #8aabcc;
  --gc-sys-text:      #5a7090;

  --gc-crt-scanline:  0;
  --gc-crt-vignette:  0;
}
```

### deep-sea — Deep Sea (dark variant, clean, high-contrast)

```css
[data-theme="deep-sea"] {
  --gc-bg:            #081420;
  --gc-panel:         #0c1c2c;
  --gc-panel-deep:    #060f18;
  --gc-input-bg:      #060f18;
  --gc-border:        #163048;
  --gc-border-hi:     #1e4060;

  --gc-text:          #c0d8e8;
  --gc-text-dim:      #3a6078;
  --gc-text-label:    #2a5068;
  --gc-text-mid:      #4a7090;

  --gc-accent:        #00b8d4;
  --gc-accent-dim:    #005868;
  --gc-accent-glow:   rgba(0,184,212,0.2);

  --gc-accent2:       #30c090;
  --gc-accent2-dim:   #185a40;
  --gc-accent2-glow:  rgba(48,192,144,0.2);

  --gc-green:         #30c090;
  --gc-red:           #e04040;
  --gc-error-bg:      #1a0808;
  --gc-error-border:  #601818;

  --gc-user-bg:       rgba(0,184,212,0.06);
  --gc-user-border:   #00b8d4;
  --gc-user-text:     #00b8d4;
  --gc-sys-border:    #163048;
  --gc-sys-text:      #2a5068;

  --gc-crt-scanline:  0;
  --gc-crt-vignette:  0;
}
```

---

## Theme Switcher UI

**Location:** Sidebar bottom status strip, appended after the "TACTICAL NET ACTIVE" indicator.

**Layout:** 3 small circular color swatches (14×14px). Active theme has a 1px ring in `--gc-accent`. Hover shows tooltip with theme name.

```
● ◉ ●
```

Swatch colors (representing each theme at a glance):
- space-dark → `#ff8c00` (amber)
- day-command → `#c05808` (warm orange)
- deep-sea → `#00b8d4` (blue-green)

Clicking a swatch: calls `setTheme(id)` which persists to localStorage and sets `data-theme` on `document.documentElement`.

---

## Theme Persistence

In `web/src/lib/api.ts`, add alongside existing `getConfig`/`saveConfig`:

```ts
export type ThemeId = 'space-dark' | 'day-command' | 'deep-sea'

export function getTheme(): ThemeId {
  return (localStorage.getItem('gc_theme') as ThemeId) ?? 'space-dark'
}

export function saveTheme(id: ThemeId): void {
  localStorage.setItem('gc_theme', id)
  document.documentElement.setAttribute('data-theme', id)
}
```

On app startup (`App.tsx`), call `saveTheme(getTheme())` to restore saved theme before first render.

`App.tsx` holds `const [theme, setTheme] = useState(getTheme)` and passes both as props to `Sidebar`. `setTheme` calls `saveTheme(id)` then updates state so the active swatch indicator re-renders.

---

## Files Changed

| File | Change |
|---|---|
| `web/src/index.css` | Add three `[data-theme]` CSS variable blocks; update all `.sp-*` classes to use `var(--gc-*)` tokens; update `body` base styles; update scrollbar, CRT overlay opacity to use vars |
| `web/src/App.tsx` | Call `saveTheme(getTheme())` on mount; pass `setTheme` down or use a lightweight state |
| `web/src/lib/api.ts` | Add `ThemeId`, `getTheme()`, `saveTheme()` |
| `web/src/components/Sidebar.tsx` | Replace inline hex values with `var(--gc-*)`; add theme switcher component at bottom |
| `web/src/pages/ChatPage.tsx` | Replace inline hex values with `var(--gc-*)` |
| `web/src/components/MessageBubble.tsx` | Replace inline hex values with `var(--gc-*)` |
| `web/src/pages/ConfigPage.tsx` | Replace generic Tailwind classes (`gray-800`, `blue-600`) with space-theme classes |
| `web/src/components/ToolCallCard.tsx` | Replace inline hex values if present |
| Other pages (Sessions, Agents, Runs) | Replace inline hex values if present |

---

## Constraints

- Space Anime Dark must be pixel-for-pixel identical to the current theme after refactor
- CRT scanline and vignette effects: `body::before` gets `opacity: var(--gc-crt-scanline)` and `body::after` gets `opacity: var(--gc-crt-vignette)`; Day Command and Deep Sea set these vars to `0`, collapsing the effects without removing the pseudo-elements
- No new npm dependencies required
- `@import "tailwindcss"` stays at line 1 (existing PostCSS ordering constraint)
