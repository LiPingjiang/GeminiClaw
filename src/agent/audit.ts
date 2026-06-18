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
