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

  it('TICK updates elapsedMs in headerState', () => {
    const s = tuiReducer(base, { type: 'TICK', elapsedMs: 1500 })
    expect(s.headerState.elapsedMs).toBe(1500)
    expect(s.headerState.status).toBe('running')
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

describe('thinking actions', () => {
  it('THINKING_DELTA accumulates content and sets startMs', () => {
    const s1 = tuiReducer(base, { type: 'THINKING_DELTA', delta: 'hello ', nowMs: 1000 })
    expect(s1.thinkingContent).toBe('hello ')
    expect(s1.thinkingStartMs).toBe(1000)
    expect(s1.thinkingDone).toBe(false)
    const s2 = tuiReducer(s1, { type: 'THINKING_DELTA', delta: 'world', nowMs: 2000 })
    expect(s2.thinkingContent).toBe('hello world')
    expect(s2.thinkingStartMs).toBe(1000) // preserved from first delta
  })

  it('THINKING_DONE sets done flag and duration, adds thinking_end event', () => {
    const s1 = tuiReducer(base, { type: 'THINKING_DELTA', delta: 'hi', nowMs: 1000 })
    const s2 = tuiReducer(s1, { type: 'THINKING_DONE', content: 'hi', durationMs: 3500 })
    expect(s2.thinkingDone).toBe(true)
    expect(s2.thinkingDurationMs).toBe(3500)
    expect(s2.events.at(-1)).toEqual({ kind: 'thinking_end', content: 'hi', durationMs: 3500 })
  })

  it('SEND_MESSAGE clears thinking state', () => {
    const s1 = tuiReducer(base, { type: 'THINKING_DELTA', delta: 'thinking', nowMs: 1000 })
    const s2 = tuiReducer(s1, { type: 'SEND_MESSAGE', message: 'hi' })
    expect(s2.thinkingContent).toBe('')
    expect(s2.thinkingDone).toBe(false)
    expect(s2.thinkingStartMs).toBe(0)
  })
})

describe('attachment actions', () => {
  const attachment = {
    base64: 'abc123',
    mediaType: 'image/png' as const,
    filename: 'clipboard',
    sizeBytes: 1024,
  }

  it('INPUT_ATTACH_IMAGE adds to attachments', () => {
    const s = tuiReducer(base, { type: 'INPUT_ATTACH_IMAGE', attachment })
    expect(s.inputAttachments).toHaveLength(1)
    expect(s.inputAttachments[0]).toEqual(attachment)
  })

  it('INPUT_CLEAR_ATTACHMENTS empties list', () => {
    const s1 = tuiReducer(base, { type: 'INPUT_ATTACH_IMAGE', attachment })
    const s2 = tuiReducer(s1, { type: 'INPUT_CLEAR_ATTACHMENTS' })
    expect(s2.inputAttachments).toHaveLength(0)
  })

  it('SEND_MESSAGE clears attachments', () => {
    const s1 = tuiReducer(base, { type: 'INPUT_ATTACH_IMAGE', attachment })
    const s2 = tuiReducer(s1, { type: 'SEND_MESSAGE', message: 'hi' })
    expect(s2.inputAttachments).toHaveLength(0)
  })
})

describe('scroll actions', () => {
  it('SCROLL_UP increases offset', () => {
    const s0 = tuiReducer(base, { type: 'SET_MAX_SCROLL_OFFSET', value: 100 })
    const s = tuiReducer(s0, { type: 'SCROLL_UP', lines: 3 })
    expect(s.scrollOffset).toBe(3)
  })

  it('SCROLL_DOWN decreases offset, clamps at 0', () => {
    const s0 = tuiReducer(base, { type: 'SET_MAX_SCROLL_OFFSET', value: 100 })
    const s1 = tuiReducer(s0, { type: 'SCROLL_UP', lines: 5 })
    const s2 = tuiReducer(s1, { type: 'SCROLL_DOWN', lines: 3 })
    expect(s2.scrollOffset).toBe(2)
    const s3 = tuiReducer(s2, { type: 'SCROLL_DOWN', lines: 10 })
    expect(s3.scrollOffset).toBe(0)
  })

  it('SCROLL_TO_BOTTOM resets to 0', () => {
    const s0 = tuiReducer(base, { type: 'SET_MAX_SCROLL_OFFSET', value: 100 })
    const s1 = tuiReducer(s0, { type: 'SCROLL_UP', lines: 10 })
    const s2 = tuiReducer(s1, { type: 'SCROLL_TO_BOTTOM' })
    expect(s2.scrollOffset).toBe(0)
  })

  it('SEND_MESSAGE resets scroll to bottom', () => {
    const s0 = tuiReducer(base, { type: 'SET_MAX_SCROLL_OFFSET', value: 100 })
    const s1 = tuiReducer(s0, { type: 'SCROLL_UP', lines: 5 })
    const s2 = tuiReducer(s1, { type: 'SEND_MESSAGE', message: 'hi' })
    expect(s2.scrollOffset).toBe(0)
  })

  it('STREAM_DELTA does not reset scroll offset', () => {
    const s0 = tuiReducer(base, { type: 'SET_MAX_SCROLL_OFFSET', value: 100 })
    const s1 = tuiReducer(s0, { type: 'SCROLL_UP', lines: 5 })
    const s2 = tuiReducer(s1, { type: 'STREAM_DELTA', content: 'hello' })
    expect(s2.scrollOffset).toBe(5)  // preserved
  })
})

describe('SET_MAX_SCROLL_OFFSET', () => {
  it('sets maxScrollOffset', () => {
    const s = tuiReducer(base, { type: 'SET_MAX_SCROLL_OFFSET', value: 42 })
    expect(s.maxScrollOffset).toBe(42)
  })
})

describe('SET_SUGGESTIONS', () => {
  const mockCmd = { name: 'clear', prefix: '/clear', description: 'Clear', handler: () => {} }

  it('sets suggestions and selected', () => {
    const s = tuiReducer(base, { type: 'SET_SUGGESTIONS', items: [mockCmd], selected: 0 })
    expect(s.suggestions).toHaveLength(1)
    expect(s.selectedSuggestion).toBe(0)
  })
})

describe('SUGGESTION_MOVE', () => {
  const mockCmd = { name: 'clear', prefix: '/clear', description: 'Clear', handler: () => {} }

  it('increments selectedSuggestion', () => {
    const s1 = tuiReducer(base, { type: 'SET_SUGGESTIONS', items: [mockCmd, mockCmd], selected: 0 })
    const s2 = tuiReducer(s1, { type: 'SUGGESTION_MOVE', delta: 1 })
    expect(s2.selectedSuggestion).toBe(1)
  })

  it('clamps at max index', () => {
    const s1 = tuiReducer(base, { type: 'SET_SUGGESTIONS', items: [mockCmd], selected: 0 })
    const s2 = tuiReducer(s1, { type: 'SUGGESTION_MOVE', delta: 5 })
    expect(s2.selectedSuggestion).toBe(0)
  })

  it('clamps at -1', () => {
    const s1 = tuiReducer(base, { type: 'SET_SUGGESTIONS', items: [mockCmd], selected: 0 })
    const s2 = tuiReducer(s1, { type: 'SUGGESTION_MOVE', delta: -5 })
    expect(s2.selectedSuggestion).toBe(-1)
  })
})

describe('SHOW_COST', () => {
  it('appends token summary to events', () => {
    const s = tuiReducer(base, { type: 'SHOW_COST' })
    expect(s.events.at(-1)?.kind).toBe('system')
    expect((s.events.at(-1) as any).message).toContain('Tokens')
  })
})

describe('BG_START / BG_DELTA / BG_DONE', () => {
  it('BG_START sets bgRunning', () => {
    const s = tuiReducer(base, { type: 'BG_START' })
    expect(s.bgRunning).toBe(true)
  })

  it('BG_DELTA accumulates content', () => {
    const s1 = tuiReducer(base, { type: 'BG_START' })
    const s2 = tuiReducer(s1, { type: 'BG_DELTA', content: 'hello ' })
    const s3 = tuiReducer(s2, { type: 'BG_DELTA', content: 'world' })
    expect(s3.bgContent).toBe('hello world')
  })

  it('BG_DONE appends response with [bg] prefix', () => {
    const s1 = tuiReducer(base, { type: 'BG_START' })
    const s2 = tuiReducer(s1, { type: 'BG_DELTA', content: 'answer' })
    const s3 = tuiReducer(s2, { type: 'BG_DONE' })
    expect(s3.bgRunning).toBe(false)
    expect(s3.bgContent).toBe('')
    expect((s3.events.at(-1) as any).content).toContain('[bg]')
  })
})

describe('SET_NEW_SESSION', () => {
  it('clears events except system message', () => {
    const s1 = tuiReducer(base, { type: 'SEND_MESSAGE', message: 'hi' })
    const s2 = tuiReducer(s1, { type: 'SET_NEW_SESSION' })
    expect(s2.events).toHaveLength(1)
    expect(s2.events[0]?.kind).toBe('system')
    expect(s2.currentSessionId).toBeUndefined()
  })
})

describe('LOAD_HISTORY', () => {
  it('prepends history events before existing events', () => {
    const s1 = tuiReducer(base, { type: 'SSE_EVENT', event: { kind: 'system', message: 'current' } })
    const history = [{ kind: 'user_message' as const, content: 'old msg' }]
    const s2 = tuiReducer(s1, { type: 'LOAD_HISTORY', events: history })
    expect(s2.events[0]).toEqual(history[0])
    expect(s2.events.at(-1)?.kind).toBe('system')
  })
})

describe('btwState', () => {
  it('BTW_START sets loading phase', () => {
    const s = tuiReducer(base, { type: 'BTW_START', question: 'what?' })
    expect(s.btwState.phase).toBe('loading')
    if (s.btwState.phase === 'loading') expect(s.btwState.question).toBe('what?')
  })

  it('BTW_DELTA from loading transitions to showing', () => {
    const s1 = tuiReducer(base, { type: 'BTW_START', question: 'q' })
    const s2 = tuiReducer(s1, { type: 'BTW_DELTA', content: 'answer' })
    expect(s2.btwState.phase).toBe('showing')
    if (s2.btwState.phase === 'showing') expect(s2.btwState.content).toBe('answer')
  })

  it('BTW_DELTA accumulates in showing phase', () => {
    const s1 = tuiReducer(base, { type: 'BTW_START', question: 'q' })
    const s2 = tuiReducer(s1, { type: 'BTW_DELTA', content: 'part1' })
    const s3 = tuiReducer(s2, { type: 'BTW_DELTA', content: ' part2' })
    if (s3.btwState.phase === 'showing') expect(s3.btwState.content).toBe('part1 part2')
  })

  it('BTW_CLOSE resets to idle', () => {
    const s1 = tuiReducer(base, { type: 'BTW_START', question: 'q' })
    const s2 = tuiReducer(s1, { type: 'BTW_CLOSE' })
    expect(s2.btwState.phase).toBe('idle')
  })

  it('BTW_SCROLL adjusts scrollOffset', () => {
    const s1 = tuiReducer(base, { type: 'BTW_START', question: 'q' })
    const s2 = tuiReducer(s1, { type: 'BTW_DELTA', content: 'x' })
    const s3 = tuiReducer(s2, { type: 'BTW_SCROLL', delta: 3 })
    if (s3.btwState.phase === 'showing') expect(s3.btwState.scrollOffset).toBe(3)
  })
})

describe('SCROLL_UP with maxScrollOffset', () => {
  it('clamps at maxScrollOffset', () => {
    const s1 = tuiReducer(base, { type: 'SET_MAX_SCROLL_OFFSET', value: 10 })
    const s2 = tuiReducer(s1, { type: 'SCROLL_UP', lines: 20 })
    expect(s2.scrollOffset).toBe(10)
  })

  it('does not exceed maxScrollOffset on repeated scroll', () => {
    const s1 = tuiReducer(base, { type: 'SET_MAX_SCROLL_OFFSET', value: 5 })
    const s2 = tuiReducer(s1, { type: 'SCROLL_UP', lines: 3 })
    const s3 = tuiReducer(s2, { type: 'SCROLL_UP', lines: 3 })
    expect(s3.scrollOffset).toBe(5)
  })
})
