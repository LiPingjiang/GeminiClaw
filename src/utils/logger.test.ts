// src/utils/logger.test.ts
import { describe, it, expect } from 'vitest'

// We test the pure formatting logic, not file I/O
import { formatLogEntry, levelToInt } from './logger.js'

describe('formatLogEntry', () => {
  it('produces valid JSON with required fields', () => {
    const entry = formatLogEntry('info', 'agent', 'turn_start', { sessionId: 'abc', turn: 1 })
    const parsed = JSON.parse(entry)
    expect(parsed.level).toBe('info')
    expect(parsed.module).toBe('agent')
    expect(parsed.event).toBe('turn_start')
    expect(parsed.sessionId).toBe('abc')
    expect(parsed.turn).toBe(1)
    expect(typeof parsed.ts).toBe('string')
    // ts should be ISO 8601
    expect(() => new Date(parsed.ts)).not.toThrow()
  })

  it('includes all extra fields', () => {
    const entry = formatLogEntry('error', 'tool', 'exec_fail', { toolName: 'read', durationMs: 42 })
    const parsed = JSON.parse(entry)
    expect(parsed.toolName).toBe('read')
    expect(parsed.durationMs).toBe(42)
  })
})

describe('levelToInt', () => {
  it('orders levels correctly', () => {
    expect(levelToInt('debug')).toBeLessThan(levelToInt('info'))
    expect(levelToInt('info')).toBeLessThan(levelToInt('warn'))
    expect(levelToInt('warn')).toBeLessThan(levelToInt('error'))
  })
})
