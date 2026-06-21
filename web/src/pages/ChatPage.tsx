import { useCallback, useEffect, useRef, useState } from 'react'
import { Send, Square } from 'lucide-react'
import { streamChat, api } from '@/lib/api'
import type { TuiEvent } from '@/lib/api'
import MessageBubble from '@/components/MessageBubble'
import ToolCallCard from '@/components/ToolCallCard'
import SessionList from '@/components/SessionList'
import type { SessionItem } from '@/components/SessionList'

interface ToolCall {
  id: string
  name: string
  input?: unknown
  output?: unknown
  status: 'running' | 'done' | 'error'
}

type DisplayItem =
  | { type: 'event'; id: string; event: Extract<TuiEvent, { kind: 'user_message' | 'response' | 'system' | 'error' }> }
  | { type: 'tool'; id: string; tool: ToolCall }
  | { type: 'streaming'; id: string }

let _seq = 0
const uid = () => String(++_seq)

export default function ChatPage() {
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>()
  const [items, setItems] = useState<DisplayItem[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [input, setInput] = useState('')
  const cancelRef = useRef<(() => void) | null>(null)
  const streamingTextRef = useRef('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const toolMapRef = useRef(new Map<string, ToolCall>())

  const loadSessions = useCallback(async () => {
    const list = await api.getSessions()
    setSessions(list.map(s => ({
      id: s.id,
      label: s.title ?? s.id.slice(0, 8) + '…',
    })))
  }, [])

  useEffect(() => { loadSessions() }, [loadSessions])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items, streamingText])

  const handleNew = () => {
    cancelRef.current?.()
    setActiveSessionId(undefined)
    setItems([])
    setStreamingText('')
    streamingTextRef.current = ''
    toolMapRef.current.clear()
  }

  const handleSelect = (id: string) => {
    cancelRef.current?.()
    setActiveSessionId(id)
    setItems([])
    setStreamingText('')
    streamingTextRef.current = ''
    toolMapRef.current.clear()
  }

  const handleSend = () => {
    const msg = input.trim()
    if (!msg || isStreaming) return
    setInput('')
    setIsStreaming(true)
    streamingTextRef.current = ''
    setStreamingText('')

    const userItemId = uid()
    const streamItemId = uid()

    setItems(prev => [
      ...prev,
      { type: 'event', id: userItemId, event: { kind: 'user_message', content: msg } },
      { type: 'streaming', id: streamItemId },
    ])

    cancelRef.current = streamChat({
      message: msg,
      sessionId: activeSessionId,

      onDelta: (text) => {
        streamingTextRef.current += text
        setStreamingText(streamingTextRef.current)
      },

      onSessionId: (id) => {
        setActiveSessionId(id)
        loadSessions()
      },

      onEvent: (event) => {
        if (event.kind === 'tool_start') {
          const tool: ToolCall = {
            id: uid(),
            name: event.name,
            input: event.input,
            status: 'running',
          }
          toolMapRef.current.set(event.name, tool)
          setItems(prev => [...prev, { type: 'tool', id: tool.id, tool: { ...tool } }])
        } else if (event.kind === 'tool_end') {
          const tool = toolMapRef.current.get(event.name)
          if (tool) {
            const updated = { ...tool, output: event.output, status: 'done' as const }
            toolMapRef.current.set(event.name, updated)
            setItems(prev => prev.map(item =>
              item.type === 'tool' && item.id === tool.id
                ? { ...item, tool: updated }
                : item,
            ))
          }
        }
      },

      onDone: () => {
        const finalText = streamingTextRef.current
        streamingTextRef.current = ''
        setStreamingText('')
        setItems(prev => {
          const without = prev.filter(i => i.id !== streamItemId)
          return finalText
            ? [...without, { type: 'event', id: uid(), event: { kind: 'response', content: finalText } }]
            : without
        })
        setIsStreaming(false)
        cancelRef.current = null
      },

      onError: (err) => {
        streamingTextRef.current = ''
        setStreamingText('')
        setItems(prev => [
          ...prev.filter(i => i.id !== streamItemId),
          { type: 'event', id: uid(), event: { kind: 'error', message: err.message } },
        ])
        setIsStreaming(false)
        cancelRef.current = null
      },
    })
  }

  const handleCancel = () => {
    cancelRef.current?.()
    cancelRef.current = null
    const finalText = streamingTextRef.current
    streamingTextRef.current = ''
    setStreamingText('')
    setIsStreaming(false)
    if (finalText) {
      setItems(prev => prev.map(i =>
        i.type === 'streaming'
          ? { type: 'event', id: i.id, event: { kind: 'response', content: finalText } }
          : i,
      ))
    } else {
      setItems(prev => prev.filter(i => i.type !== 'streaming'))
    }
  }

  return (
    <div className="flex h-full overflow-hidden">
      <SessionList
        sessions={sessions}
        activeId={activeSessionId}
        onSelect={handleSelect}
        onNew={handleNew}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-6">
          {items.length === 0 && (
            <div className="h-full flex items-center justify-center">
              <p className="text-gray-600 text-sm">Start a conversation…</p>
            </div>
          )}
          {items.map(item => {
            if (item.type === 'event') {
              return <MessageBubble key={item.id} event={item.event} />
            }
            if (item.type === 'tool') {
              return (
                <ToolCallCard
                  key={item.id}
                  name={item.tool.name}
                  input={item.tool.input}
                  output={item.tool.output}
                  status={item.tool.status}
                />
              )
            }
            if (item.type === 'streaming') {
              return (
                <MessageBubble
                  key={item.id}
                  event={{ kind: 'response', content: streamingText }}
                  streaming
                />
              )
            }
            return null
          })}
          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div className="shrink-0 p-4 border-t border-gray-800">
          <div className="flex gap-2 items-end">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              placeholder="Message GeminiClaw… (Enter to send, Shift+Enter for newline)"
              rows={1}
              className="flex-1 resize-none bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
              style={{ minHeight: '48px', maxHeight: '200px' }}
            />
            {isStreaming ? (
              <button
                onClick={handleCancel}
                className="shrink-0 px-4 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-xl transition-colors"
                title="Cancel"
              >
                <Square size={15} />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                className="shrink-0 px-4 py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl transition-colors"
              >
                <Send size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
