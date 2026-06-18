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
const stderrMinLevel = GC_LOG_LEVEL ? levelToInt(GC_LOG_LEVEL) : 999 // no stderr by default

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
