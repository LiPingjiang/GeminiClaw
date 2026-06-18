import type { TuiEvent, HeaderState, TokenUsage } from './types.js'

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

    default:
      return state
  }
}
