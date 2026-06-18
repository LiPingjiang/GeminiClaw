import { describe, it, expect } from 'vitest'
import { tuiReducer, initialTuiState } from './state.js'
import type { TuiAction } from './state.js'

const base = initialTuiState({})

describe('tuiReducer', () => {
  it('INPUT_CHANGE updates input and cursor', () => {
    const s = tuiReducer(base, { type: 'INPUT_CHANGE', value: 'hello', cursor: 5 })
    expect(s.input).toBe('hello')
    expect(s.inputCursor).toBe(5)
  })

  it('SEND_MESSAGE moves input to history, clears input, sets isRunning', () => {
    const s0 = tuiReducer(base, { type: 'INPUT_CHANGE', value: 'hi', cursor: 2 })
    const s1 = tuiReducer(s0, { type: 'SEND_MESSAGE', message: 'hi' })
    expect(s1.isRunning).toBe(true)
    expect(s1.input).toBe('')
    expect(s1.inputCursor).toBe(0)
    expect(s1.history[0]).toBe('hi')
    expect(s1.events.at(-1)).toEqual({ kind: 'user_message', content: 'hi' })
  })

  it('INPUT_HISTORY_UP retrieves previous message', () => {
    const s0 = tuiReducer(base, { type: 'SEND_MESSAGE', message: 'first' })
    const s1 = tuiReducer(s0, { type: 'STREAM_DONE' })
    const s2 = tuiReducer(s1, { type: 'INPUT_HISTORY_UP' })
    expect(s2.input).toBe('first')
    expect(s2.historyIdx).toBe(0)
  })

  it('INPUT_HISTORY_DOWN after UP returns to empty', () => {
    const s0 = tuiReducer(base, { type: 'SEND_MESSAGE', message: 'first' })
    const s1 = tuiReducer(s0, { type: 'STREAM_DONE' })
    const s2 = tuiReducer(s1, { type: 'INPUT_HISTORY_UP' })
    const s3 = tuiReducer(s2, { type: 'INPUT_HISTORY_DOWN' })
    expect(s3.input).toBe('')
    expect(s3.historyIdx).toBe(-1)
  })

  it('STREAM_DELTA accumulates content', () => {
    const s1 = tuiReducer(base, { type: 'STREAM_DELTA', content: 'hello' })
    const s2 = tuiReducer(s1, { type: 'STREAM_DELTA', content: ' world' })
    expect(s2.streamingContent).toBe('hello world')
  })

  it('STREAM_DONE saves streaming content as response event and clears it', () => {
    const s1 = tuiReducer(base, { type: 'STREAM_DELTA', content: 'answer' })
    const s2 = tuiReducer(s1, { type: 'STREAM_DONE' })
    expect(s2.streamingContent).toBe('')
    expect(s2.isRunning).toBe(false)
    expect(s2.events.at(-1)).toEqual({ kind: 'response', content: 'answer' })
  })

  it('STREAM_DONE with no content does not append empty response event', () => {
    const eventsBefore = base.events.length
    const s = tuiReducer(base, { type: 'STREAM_DONE' })
    expect(s.events.length).toBe(eventsBefore)
  })

  it('CLEAR wipes events and streaming content', () => {
    const s1 = tuiReducer(base, { type: 'STREAM_DELTA', content: 'x' })
    const s2 = tuiReducer(s1, { type: 'CLEAR' })
    expect(s2.events).toEqual([])
    expect(s2.streamingContent).toBe('')
  })

  it('SESSION_ID updates currentSessionId', () => {
    const s = tuiReducer(base, { type: 'SESSION_ID', id: 'abc-123' })
    expect(s.currentSessionId).toBe('abc-123')
  })

  it('RESIZE updates termSize', () => {
    const s = tuiReducer(base, { type: 'RESIZE', rows: 40, columns: 120 })
    expect(s.termSize).toEqual({ rows: 40, columns: 120 })
  })

  it('history is capped at 100 entries', () => {
    let s = base
    for (let i = 0; i < 105; i++) {
      s = tuiReducer(s, { type: 'SEND_MESSAGE', message: `msg${i}` })
      s = tuiReducer(s, { type: 'STREAM_DONE' })
    }
    expect(s.history.length).toBe(100)
  })
})
