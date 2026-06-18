import type { TuiEvent, HeaderState, TokenUsage } from './types.js'
import type { TuiCommand } from './commands/registry.js'

export type BtwPhase =
  | { phase: 'idle' }
  | { phase: 'loading'; question: string }
  | { phase: 'showing'; question: string; content: string; scrollOffset: number }

export interface InputAttachment {
  base64: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  filename: string
  sizeBytes: number
}

export interface TuiState {
  events: TuiEvent[]
  headerState: HeaderState
  input: string
  inputCursor: number
  isRunning: boolean
  currentSessionId: string | undefined
  streamingContent: string
  termSize: { rows: number; columns: number }
  history: string[]
  historyIdx: number
  sessionStats: {
    totalInput: number
    totalOutput: number
    totalCacheRead: number
    totalCacheCreation: number
  }
  // Thinking mode
  thinkingContent: string
  thinkingStartMs: number
  thinkingDone: boolean
  thinkingDurationMs: number
  // Clipboard attachments
  inputAttachments: InputAttachment[]
  // Scroll
  scrollOffset: number
  maxScrollOffset: number
  // Suggestions
  suggestions: TuiCommand[]
  selectedSuggestion: number
  // Background task
  bgRunning: boolean
  bgContent: string
  // Btw modal
  btwState: BtwPhase
}

export type TuiAction =
  | { type: 'INPUT_CHANGE'; value: string; cursor: number }
  | { type: 'INPUT_HISTORY_UP' }
  | { type: 'INPUT_HISTORY_DOWN' }
  | { type: 'SEND_MESSAGE'; message: string }
  | { type: 'STREAM_DELTA'; content: string }
  | { type: 'STREAM_DONE' }
  | { type: 'STREAM_ERROR'; message: string }
  | { type: 'SSE_EVENT'; event: TuiEvent }
  | { type: 'CANCEL' }
  | { type: 'CLEAR' }
  | { type: 'SESSION_ID'; id: string }
  | { type: 'RESIZE'; rows: number; columns: number }
  | { type: 'AGENT_END'; model?: string; usage?: TokenUsage }
  | { type: 'TICK'; elapsedMs: number }
  | { type: 'THINKING_DELTA'; delta: string; nowMs: number }
  | { type: 'THINKING_DONE'; content: string; durationMs: number }
  | { type: 'THINKING_CLEAR' }
  | { type: 'INPUT_ATTACH_IMAGE'; attachment: InputAttachment }
  | { type: 'INPUT_CLEAR_ATTACHMENTS' }
  | { type: 'SCROLL_UP'; lines: number }
  | { type: 'SCROLL_DOWN'; lines: number }
  | { type: 'SCROLL_TO_BOTTOM' }
  | { type: 'SET_MAX_SCROLL_OFFSET'; value: number }
  | { type: 'SET_SUGGESTIONS'; items: TuiCommand[]; selected: number }
  | { type: 'SUGGESTION_MOVE'; delta: number }
  | { type: 'SUGGESTION_CLEAR' }
  | { type: 'SHOW_COST' }
  | { type: 'COPY_LAST' }
  | { type: 'BG_START' }
  | { type: 'BG_DELTA'; content: string }
  | { type: 'BG_DONE' }
  | { type: 'BTW_START'; question: string }
  | { type: 'BTW_DELTA'; content: string }
  | { type: 'BTW_DONE' }
  | { type: 'BTW_CLOSE' }
  | { type: 'BTW_SCROLL'; delta: number }
  | { type: 'SET_NEW_SESSION' }
  | { type: 'LOAD_HISTORY'; events: TuiEvent[] }

export interface InitialTuiStateOpts {
  sessionId?: string
  baseUrl?: string
  model?: string
}

export function initialTuiState(opts: InitialTuiStateOpts): TuiState {
  return {
    events: [],
    headerState: { status: 'idle' },
    input: '',
    inputCursor: 0,
    isRunning: false,
    currentSessionId: opts.sessionId,
    streamingContent: '',
    termSize: {
      rows: process.stdout.rows || 24,
      columns: process.stdout.columns || 80,
    },
    history: [],
    historyIdx: -1,
    sessionStats: { totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheCreation: 0 },
    thinkingContent: '',
    thinkingStartMs: 0,
    thinkingDone: false,
    thinkingDurationMs: 0,
    inputAttachments: [],
    scrollOffset: 0,
    maxScrollOffset: 0,
    suggestions: [],
    selectedSuggestion: -1,
    bgRunning: false,
    bgContent: '',
    btwState: { phase: 'idle' },
  }
}

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'INPUT_CHANGE':
      return { ...state, input: action.value, inputCursor: action.cursor }

    case 'INPUT_HISTORY_UP': {
      if (state.history.length === 0) return state
      const nextIdx = Math.min(state.historyIdx + 1, state.history.length - 1)
      if (nextIdx === state.historyIdx) return state
      return { ...state, historyIdx: nextIdx, input: state.history[nextIdx] ?? '', inputCursor: (state.history[nextIdx] ?? '').length }
    }

    case 'INPUT_HISTORY_DOWN': {
      const nextIdx = state.historyIdx - 1
      if (nextIdx < 0) return { ...state, historyIdx: -1, input: '', inputCursor: 0 }
      return { ...state, historyIdx: nextIdx, input: state.history[nextIdx] ?? '', inputCursor: (state.history[nextIdx] ?? '').length }
    }

    case 'SEND_MESSAGE':
      return {
        ...state,
        isRunning: true,
        input: '',
        inputCursor: 0,
        historyIdx: -1,
        history: [action.message, ...state.history].slice(0, 100),
        events: [...state.events, { kind: 'user_message', content: action.message }],
        streamingContent: '',
        scrollOffset: 0,
        inputAttachments: [],
        thinkingContent: '',
        thinkingStartMs: 0,
        thinkingDone: false,
        thinkingDurationMs: 0,
        headerState: { ...state.headerState, status: 'running', elapsedMs: 0, currentTool: undefined },
      }

    case 'STREAM_DELTA':
      return { ...state, streamingContent: state.streamingContent + action.content }

    case 'STREAM_DONE': {
      const newEvents = state.streamingContent
        ? [...state.events, { kind: 'response' as const, content: state.streamingContent }]
        : state.events
      return {
        ...state,
        isRunning: false,
        streamingContent: '',
        events: newEvents,
        headerState: { ...state.headerState, status: 'idle', currentTool: undefined },
      }
    }

    case 'STREAM_ERROR':
      return {
        ...state,
        isRunning: false,
        streamingContent: '',
        events: [...state.events, { kind: 'error', message: action.message }],
        headerState: { ...state.headerState, status: 'error' },
      }

    case 'CANCEL':
      return {
        ...state,
        isRunning: false,
        streamingContent: '',
        events: [...state.events, { kind: 'system', message: 'Interrupted.' }],
        headerState: { ...state.headerState, status: 'idle', currentTool: undefined },
      }

    case 'CLEAR':
      return { ...state, events: [], streamingContent: '' }

    case 'SESSION_ID':
      return {
        ...state,
        currentSessionId: action.id,
        headerState: { ...state.headerState, sessionId: action.id },
      }

    case 'RESIZE':
      return { ...state, termSize: { rows: action.rows, columns: action.columns } }

    case 'AGENT_END': {
      const usage = action.usage
      const stats = usage
        ? {
            totalInput: state.sessionStats.totalInput + (usage.inputTokens ?? 0),
            totalOutput: state.sessionStats.totalOutput + (usage.outputTokens ?? 0),
            totalCacheRead: state.sessionStats.totalCacheRead + (usage.cacheReadInputTokens ?? 0),
            totalCacheCreation: state.sessionStats.totalCacheCreation + (usage.cacheCreationInputTokens ?? 0),
          }
        : state.sessionStats
      const lastTurnTokens = usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : undefined
      return {
        ...state,
        sessionStats: stats,
        headerState: {
          ...state.headerState,
          model: action.model ?? state.headerState.model,
          totalInputTokens: stats.totalInput,
          totalOutputTokens: stats.totalOutput,
          totalCacheReadTokens: stats.totalCacheRead,
          totalCacheCreationTokens: stats.totalCacheCreation,
          lastTurnTokens,
        },
      }
    }

    case 'SSE_EVENT': {
      const event = action.event
      const newEvents = [...state.events, event]
      let headerState = state.headerState
      if (event.kind === 'tool_start') {
        headerState = { ...headerState, currentTool: event.name }
      } else if (event.kind === 'tool_end') {
        headerState = { ...headerState, currentTool: undefined }
      } else if (event.kind === 'turn_start') {
        headerState = { ...headerState, turn: event.turn }
      }
      return { ...state, events: newEvents, headerState }
    }

    case 'TICK':
      return {
        ...state,
        headerState: { ...state.headerState, elapsedMs: action.elapsedMs, status: 'running' },
      }

    case 'THINKING_DELTA':
      return {
        ...state,
        thinkingContent: state.thinkingContent + action.delta,
        thinkingStartMs: state.thinkingStartMs || action.nowMs,
        thinkingDone: false,
      }

    case 'THINKING_DONE':
      return {
        ...state,
        thinkingDone: true,
        thinkingDurationMs: action.durationMs,
        thinkingContent: action.content,
        events: [...state.events, { kind: 'thinking_end' as const, content: action.content, durationMs: action.durationMs }],
      }

    case 'THINKING_CLEAR':
      return {
        ...state,
        thinkingContent: '',
        thinkingStartMs: 0,
        thinkingDone: false,
        thinkingDurationMs: 0,
      }

    case 'INPUT_ATTACH_IMAGE':
      return { ...state, inputAttachments: [...state.inputAttachments, action.attachment] }

    case 'INPUT_CLEAR_ATTACHMENTS':
      return { ...state, inputAttachments: [] }

    case 'SCROLL_UP':
      return { ...state, scrollOffset: Math.min(state.scrollOffset + action.lines, state.maxScrollOffset) }

    case 'SCROLL_DOWN':
      return { ...state, scrollOffset: Math.max(0, state.scrollOffset - action.lines) }

    case 'SCROLL_TO_BOTTOM':
      return { ...state, scrollOffset: 0 }

    case 'SET_MAX_SCROLL_OFFSET':
      return { ...state, maxScrollOffset: action.value }

    case 'SET_SUGGESTIONS':
      return { ...state, suggestions: action.items, selectedSuggestion: action.selected }

    case 'SUGGESTION_MOVE': {
      const total = state.suggestions.length
      if (total === 0) return state
      const next = state.selectedSuggestion + action.delta
      return { ...state, selectedSuggestion: Math.max(-1, Math.min(next, total - 1)) }
    }

    case 'SUGGESTION_CLEAR':
      return { ...state, suggestions: [], selectedSuggestion: -1 }

    case 'SHOW_COST': {
      const { totalInput, totalOutput, totalCacheRead } = state.sessionStats
      const msg = `Tokens — in: ${totalInput.toLocaleString()} out: ${totalOutput.toLocaleString()} cache: ${totalCacheRead.toLocaleString()}`
      return { ...state, events: [...state.events, { kind: 'system', message: msg }] }
    }

    case 'COPY_LAST':
      // Side effect (actual clipboard write) is in handlers.ts
      // Reducer just returns state unchanged — the handler dispatches SSE_EVENT after copy
      return state

    case 'BG_START':
      return { ...state, bgRunning: true, bgContent: '' }

    case 'BG_DELTA':
      return { ...state, bgContent: state.bgContent + action.content }

    case 'BG_DONE': {
      const bgMsg = state.bgContent ? `[bg] ${state.bgContent}` : ''
      return {
        ...state,
        bgRunning: false,
        bgContent: '',
        events: bgMsg ? [...state.events, { kind: 'response' as const, content: bgMsg }] : state.events,
      }
    }

    case 'BTW_START':
      return { ...state, btwState: { phase: 'loading', question: action.question } }

    case 'BTW_DELTA':
      if (state.btwState.phase === 'loading') {
        return { ...state, btwState: { phase: 'showing', question: state.btwState.question, content: action.content, scrollOffset: 0 } }
      }
      if (state.btwState.phase === 'showing') {
        return { ...state, btwState: { ...state.btwState, content: state.btwState.content + action.content } }
      }
      return state

    case 'BTW_DONE':
      if (state.btwState.phase === 'loading') {
        return { ...state, btwState: { phase: 'showing', question: state.btwState.question, content: '(no response)', scrollOffset: 0 } }
      }
      return state

    case 'BTW_CLOSE':
      return { ...state, btwState: { phase: 'idle' } }

    case 'BTW_SCROLL':
      if (state.btwState.phase === 'showing') {
        const lines = state.btwState.content.split('\n').length
        const maxScroll = Math.max(0, lines - 12)  // 12 = MAX_HEIGHT in BtwModal
        const newOffset = Math.min(maxScroll, Math.max(0, state.btwState.scrollOffset + action.delta))
        return { ...state, btwState: { ...state.btwState, scrollOffset: newOffset } }
      }
      return state

    case 'SET_NEW_SESSION':
      return {
        ...state,
        streamingContent: '',
        currentSessionId: undefined,
        scrollOffset: 0,
        events: [{ kind: 'system' as const, message: 'New session started.' }],
      }

    case 'LOAD_HISTORY':
      return { ...state, events: [...action.events, ...state.events] }

    default:
      return state
  }
}
