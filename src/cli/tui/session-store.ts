// src/cli/tui/session-store.ts
// Shared utility for persisting the last-used session ID.
// Lives here (not in tui.ts) so app.tsx can import it without creating a
// circular dependency (tui.ts → tui/index.ts → app.tsx → tui.ts).

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
