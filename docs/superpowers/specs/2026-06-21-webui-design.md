# GeminiClaw Web UI (方案三) Design Spec

## Goal

Build a complete local web Dashboard for GeminiClaw — replacing the failed TUI approaches — served by the existing Fastify backend. Users open `http://localhost:18888` in a browser to chat with the agent and manage sessions, agents, runs, and config.

## Architecture

```
GeminiClaw/
├── src/                         # Existing Fastify backend (unchanged)
│   └── server/
│       ├── routes/              # Existing API routes (/v1/…)
│       └── static.ts            # NEW: serve web/dist/ as static files
├── web/                         # NEW: Vite frontend project
│   ├── src/
│   │   ├── pages/
│   │   │   ├── ChatPage.tsx
│   │   │   ├── SessionsPage.tsx
│   │   │   ├── AgentsPage.tsx
│   │   │   ├── RunsPage.tsx
│   │   │   └── ConfigPage.tsx
│   │   ├── components/
│   │   │   ├── Sidebar.tsx
│   │   │   ├── MessageBubble.tsx
│   │   │   ├── ToolCallCard.tsx
│   │   │   ├── StreamingText.tsx
│   │   │   └── SessionList.tsx
│   │   ├── lib/
│   │   │   └── api.ts           # fetch/SSE client pointing to /v1/…
│   │   ├── App.tsx              # Router + Layout
│   │   └── main.tsx
│   ├── index.html
│   ├── package.json
│   ├── tailwind.config.ts
│   └── vite.config.ts           # dev: proxy /v1 → localhost:18888
└── package.json                 # root: add build:web / dev:web scripts
```

**Tech Stack:** React 19, Vite, Tailwind CSS v4, shadcn/ui, react-router-dom v7, lucide-react, react-markdown, highlight.js

**Reference:** openclaw/ui (sidebar + multi-page), hermes-agent/web (ChatSidebar, ToolCallCard, Markdown)

## Pages

### Chat (`/`)
- Left panel: `SessionList` — existing sessions, "New Chat" button, click to switch
- Main area: `MessageList` — scrollable, each message as `MessageBubble`
- `ToolCallCard` inline — collapses by default, expand to see JSON input/output
- `InputBar` — multiline textarea, Enter to send, Shift+Enter for newline, slash-command hint
- Streaming: SSE delta events appended character-by-character via `StreamingText`

### Sessions (`/sessions`)
- Table: Session ID | Created | Message count | Last active | Actions (open in Chat / delete)
- Fetches `GET /v1/sessions`

### Agents (`/agents`)
- Card grid: agent name | status badge | last active time
- Fetches `GET /v1/agents`

### Runs (`/runs`)
- Table: Run ID | Agent | Status | Duration | Actions (view trace)
- Fetches `GET /v1/runs`

### Config (`/config`)
- Form stored in `localStorage`:
  - Server URL (default `http://localhost:18888`)
  - Auth Token (optional)
  - Default Model

## Key Components

### `MessageBubble`
Three variants: `user` (right-aligned, blue), `assistant` (left-aligned, gray, Markdown rendered), `system` (dimmed, center). Assistant bubbles support streaming append without re-render flicker.

### `ToolCallCard`
Collapsed: shows tool name + status icon. Expanded: two-pane JSON viewer (input / output). Inline within the assistant message thread, not modal.

### `StreamingText`
Receives delta strings, appends to internal ref (not state) for performance, flushes to DOM via `requestAnimationFrame`. Prevents React re-render on every character.

### `api.ts`

```typescript
// Streaming chat via fetch POST + ReadableStream
// (/v1/agent/chat is POST, so EventSource cannot be used)
export function streamChat(opts: {
  baseUrl: string
  message: string
  sessionId?: string
  model?: string
  authToken?: string
  onDelta: (text: string) => void
  onEvent: (event: { kind: string; [k: string]: unknown }) => void
  onDone: (sessionId: string) => void
  onError: (err: Error) => void
}): () => void   // returns cancel function (calls AbortController.abort())

// REST helpers
export const api = {
  getSessions: () => fetch('/v1/sessions').then(r => r.json()),
  deleteSession: (id: string) => fetch(`/v1/sessions/${id}`, { method: 'DELETE' }),
  getAgents: () => fetch('/v1/agents').then(r => r.json()),
  getRuns: () => fetch('/v1/runs').then(r => r.json()),
}
```

## Server Integration

**New file `src/server/static.ts`:**
```typescript
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

export async function registerStatic(fastify: FastifyInstance) {
  const webDist = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist')
  await fastify.register(import('@fastify/static'), {
    root: webDist,
    prefix: '/',
    decorateReply: false,
  })
  // SPA fallback — all non-/v1 routes serve index.html
  fastify.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/v1')) return reply.status(404).send({ error: 'Not found' })
    return reply.sendFile('index.html')
  })
}
```

`src/server/index.ts` calls `registerStatic(fastify)` after registering API routes.

## Build & Dev Workflow

**Development:**
```bash
# Terminal 1: start Fastify backend
pnpm dev

# Terminal 2: start Vite (proxies /v1 → :18888)
pnpm dev:web
# Open http://localhost:5173
```

**Production:**
```bash
pnpm build        # tsc → dist/
pnpm build:web    # vite build → web/dist/
node dist/index.js
# Open http://localhost:18888
```

**Root `package.json` additions:**
```json
{
  "scripts": {
    "build:web": "pnpm --filter web build",
    "dev:web": "pnpm --filter web dev",
    "dev:all": "concurrently \"pnpm dev\" \"pnpm dev:web\""
  }
}
```

**`web/vite.config.ts` dev proxy:**
```typescript
server: {
  proxy: {
    '/v1': { target: 'http://localhost:18888', changeOrigin: true }
  }
}
```

## Global Constraints

- Create root `pnpm-workspace.yaml` (currently missing): `packages: ['web']`; this makes `pnpm --filter web` work
- `web/` is a standalone Vite project registered as a pnpm workspace package
- All API calls use relative paths (`/v1/…`) — works in both dev (Vite proxy) and prod (same origin)
- Auth token read from `localStorage` key `gc_auth_token`, sent as `Authorization: Bearer <token>` header
- No SSR; pure SPA with client-side routing via react-router-dom
- shadcn/ui components installed via `npx shadcn@latest add` — do NOT copy components manually
- Tailwind CSS v4 (`@tailwindcss/vite` plugin, no `tailwind.config.js` needed for v4)
- TypeScript strict mode in `web/tsconfig.json`
- No test suite for web in v1 (backend tests stay green)
