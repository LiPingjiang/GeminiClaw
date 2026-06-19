// Stub utilities for CC's utils/messages.ts API surface
// Only functions that REPL.tsx actually calls at runtime need real implementations.
// The rest remain no-op stubs.

import { randomUUID } from 'crypto'

// ---------- Type stubs -------------------------------------------------------

export type StreamingToolUse = any
export type StreamingThinking = any

// ---------- Stubs that are imported but not called on the hot path -----------

export function formatMessage(..._args: any[]): any { return undefined as any }
export function getLastAssistantMessage(..._args: any[]): any { return undefined as any }
export function normalizeMessagesForAPI(..._args: any[]): any { return undefined as any }
export function buildMessageLookups(..._args: any[]): any { return undefined as any }
export const EMPTY_LOOKUPS: any = {}
export function extractTextContent(..._args: any[]): any { return undefined as any }
export function normalizeMessages(..._args: any[]): any { return undefined as any }
export function textForResubmit(..._args: any[]): any { return undefined as any }

// ---------- Compact boundary helpers ----------------------------------------

export function isCompactBoundaryMessage(msg: any): boolean {
  return msg?.type === 'system' && msg?.subtype === 'compact_boundary'
}

export function getMessagesAfterCompactBoundary(
  messages: any[],
  _opts?: { includeSnipped?: boolean },
): any[] {
  // Find the last compact boundary and return everything after it.
  // If none, return all messages.
  const idx = messages.map((m, i) => ({ m, i }))
    .filter(({ m }) => isCompactBoundaryMessage(m))
    .at(-1)?.i
  return idx !== undefined ? messages.slice(idx) : messages
}

// ---------- Content extraction -----------------------------------------------

export function getContentText(content: any): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = content
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text ?? '')
    return texts.length > 0 ? texts.join('') : null
  }
  return null
}

// ---------- Message creators -------------------------------------------------

export function createUserMessage(opts: any): any {
  return {
    type: 'user',
    uuid: opts.uuid ?? randomUUID(),
    timestamp: opts.timestamp ?? new Date().toISOString(),
    isMeta: opts.isMeta ?? false,
    isVirtual: opts.isVirtual ?? false,
    isCompactSummary: opts.isCompactSummary ?? false,
    isVisibleInTranscriptOnly: opts.isVisibleInTranscriptOnly ?? false,
    message: {
      role: 'user',
      content: opts.content ?? '',
    },
    toolUseResult: opts.toolUseResult,
    mcpMeta: opts.mcpMeta,
  }
}

export function createAssistantMessage(opts: {
  content: string | any[]
  usage?: any
  isVirtual?: true
}): any {
  const { content, usage, isVirtual } = opts
  const blocks = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: randomUUID(),
      model: 'geminiclaw',
      role: 'assistant',
      content: blocks,
      stop_reason: 'end_turn',
      stop_sequence: null,
      type: 'message',
      usage: usage ?? { input_tokens: 0, output_tokens: 0 },
      container: null,
      context_management: null,
    },
    requestId: undefined,
    apiError: undefined,
    error: undefined,
    errorDetails: undefined,
    isApiErrorMessage: false,
    isVirtual,
  }
}

export function createSystemMessage(opts: any): any {
  return {
    type: 'system',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    ...opts,
  }
}

export function createTurnDurationMessage(opts: any): any {
  return createSystemMessage({ subtype: 'turn_duration', ...opts })
}

export function createAgentsKilledMessage(opts: any): any {
  return createSystemMessage({ subtype: 'agents_killed', ...opts })
}

export function createApiMetricsMessage(opts: any): any {
  return createSystemMessage({ subtype: 'api_metrics', ...opts })
}

export function createCommandInputMessage(opts: any): any {
  return createUserMessage({ ...opts, isMeta: true })
}

export function formatCommandInputTags(..._args: any[]): string {
  return ''
}

// ---------- handleMessageFromStream ------------------------------------------
// This is the core function REPL.tsx calls for every event from query().
// It dispatches on the event type and calls the appropriate callback.

export function handleMessageFromStream(
  message: any,
  onMessage: (message: any) => void,
  onUpdateLength: (newContent: string) => void,
  onSetStreamMode: (mode: string) => void,
  onStreamingToolUses: (f: (current: any[]) => any[]) => void,
  onTombstone?: (message: any) => void,
  onStreamingThinking?: (f: (current: any) => any) => void,
  onApiMetrics?: (metrics: { ttftMs: number }) => void,
  onStreamingText?: (f: (current: string | null) => string | null) => void,
): void {
  if (message == null) return

  // Non-stream events: pass directly to onMessage
  if (message.type !== 'stream_event' && message.type !== 'stream_request_start') {
    if (message.type === 'tombstone') {
      onTombstone?.(message.message)
      return
    }
    if (message.type === 'tool_use_summary') {
      return
    }
    if (message.type === 'assistant') {
      const thinkingBlock = message.message?.content?.find?.(
        (b: any) => b?.type === 'thinking',
      )
      if (thinkingBlock) {
        onStreamingThinking?.(() => ({
          thinking: thinkingBlock.thinking,
          isStreaming: false,
          streamingEndedAt: Date.now(),
        }))
      }
    }
    onStreamingText?.(() => null)
    onMessage(message)
    return
  }

  // stream_request_start
  if (message.type === 'stream_request_start') {
    onSetStreamMode('requesting')
    return
  }

  // stream_event — dispatch on event.type
  const event = message.event
  if (!event) return

  if (event.type === 'message_start') {
    if (message.ttftMs != null) {
      onApiMetrics?.({ ttftMs: message.ttftMs })
    }
    return
  }

  if (event.type === 'message_stop') {
    onSetStreamMode('tool-use')
    onStreamingToolUses(() => [])
    return
  }

  switch (event.type) {
    case 'content_block_start':
      onStreamingText?.(() => null)
      switch (event.content_block?.type) {
        case 'thinking':
        case 'redacted_thinking':
          onSetStreamMode('thinking')
          return
        case 'text':
          onSetStreamMode('responding')
          return
        case 'tool_use':
          onSetStreamMode('tool-input')
          if (event.content_block) {
            onStreamingToolUses(_ => [
              ..._,
              { index: event.index, contentBlock: event.content_block, unparsedToolInput: '' },
            ])
          }
          return
        default:
          onSetStreamMode('tool-input')
          return
      }

    case 'content_block_delta': {
      const delta = event.delta
      if (!delta) return
      switch (delta.type) {
        case 'text_delta': {
          const text: string = delta.text ?? ''
          onUpdateLength(text)
          onStreamingText?.(prev => (prev ?? '') + text)
          return
        }
        case 'input_json_delta': {
          const partial: string = delta.partial_json ?? ''
          const idx: number = event.index ?? 0
          onUpdateLength(partial)
          onStreamingToolUses(_ => {
            const el = _.find(e => e.index === idx)
            if (!el) return _
            return [
              ..._.filter(e => e !== el),
              { ...el, unparsedToolInput: el.unparsedToolInput + partial },
            ]
          })
          return
        }
        case 'thinking_delta':
          onUpdateLength(delta.thinking ?? '')
          return
        default:
          return
      }
    }

    case 'content_block_stop':
      return

    case 'message_delta':
      onSetStreamMode('responding')
      return

    default:
      onSetStreamMode('responding')
      return
  }
}
