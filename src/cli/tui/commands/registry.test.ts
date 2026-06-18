import { describe, it, expect } from 'vitest'
import { filterCommands, COMMANDS } from './registry.js'

describe('COMMANDS', () => {
  it('has at least 8 commands', () => {
    expect(COMMANDS.length).toBeGreaterThanOrEqual(8)
  })

  it('all commands have prefix starting with /', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.prefix).toMatch(/^\//)
    }
  })

  it('prefix is /name', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.prefix).toBe(`/${cmd.name}`)
    }
  })
})

describe('filterCommands', () => {
  it('empty query returns up to 6 commands', () => {
    const results = filterCommands('')
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(6)
  })

  it('prefix match returns matching commands', () => {
    const results = filterCommands('cl')
    expect(results.some(c => c.name === 'clear')).toBe(true)
  })

  it('substring match works', () => {
    const results = filterCommands('session')
    expect(results.some(c => c.name === 'session')).toBe(true)
  })

  it('no match returns empty array', () => {
    expect(filterCommands('zzznomatch')).toHaveLength(0)
  })

  it('returns at most 6 results', () => {
    expect(filterCommands('').length).toBeLessThanOrEqual(6)
  })
})
