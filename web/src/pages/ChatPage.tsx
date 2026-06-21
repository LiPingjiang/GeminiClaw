import { useCallback, useEffect, useRef, useState } from 'react'
import { Send, Square, Plus, MessageSquare, Cpu, AlertTriangle } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { streamChat, api, getConfig } from '@/lib/api'
import type { TuiEvent, Agent } from '@/lib/api'
import MessageBubble from '@/components/MessageBubble'
import ToolCallCard from '@/components/ToolCallCard'
import { cn } from '@/lib/utils'
interface SessionItem { id: string; label: string }

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
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>()
  const [noAuth, setNoAuth] = useState(!getConfig().authToken)
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

  const loadAgents = useCallback(async () => {
    const list = await api.getAgents()
    setAgents(list)
  }, [])

  useEffect(() => {
    loadSessions()
    loadAgents()
  }, [loadSessions, loadAgents])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items, streamingText])

  const resetChat = () => {
    cancelRef.current?.()
    cancelRef.current = null
    setItems([])
    setStreamingText('')
    streamingTextRef.current = ''
    toolMapRef.current.clear()
    setIsStreaming(false)
  }

  const handleNew = () => { resetChat(); setActiveSessionId(undefined) }

  const handleSelect = (id: string) => { resetChat(); setActiveSessionId(id) }

  const handleSelectAgent = (agent: Agent) => {
    if (agent.session_id) handleSelect(agent.session_id)
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
        loadAgents()
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
        const is401 = err.message.includes('401')
        if (is401) setNoAuth(true)
        setItems(prev => [
          ...prev.filter(i => i.id !== streamItemId),
          {
            type: 'event', id: uid(), event: {
              kind: 'error',
              message: is401
                ? '认证失败 — 请前往 Config 页面设置 Auth Token'
                : err.message,
            },
          },
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
      {/* Left panel: agents + sessions */}
      <aside className="w-52 shrink-0 flex flex-col bg-gray-900 border-r border-gray-800">
        <div className="p-3 border-b border-gray-800">
          <button
            onClick={handleNew}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
          >
            <Plus size={13} />
            New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {/* Agents section */}
          {agents.length > 0 && (
            <div>
              <div className="px-3 pt-3 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Agents
              </div>
              {agents.map(a => (
                <button
                  key={a.id}
                  onClick={() => handleSelectAgent(a)}
                  disabled={!a.session_id}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors',
                    a.session_id && activeSessionId === a.session_id
                      ? 'bg-blue-600/20 text-blue-300'
                      : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200',
                    !a.session_id && 'opacity-40 cursor-not-allowed',
                  )}
                >
                  <Cpu size={12} className="shrink-0" />
                  <span className="truncate flex-1">{a.name}</span>
                  <span className={cn(
                    'text-[10px] px-1 rounded shrink-0',
                    a.status === 'active' ? 'text-green-400' : 'text-gray-600',
                  )}>●</span>
                </button>
              ))}
            </div>
          )}
          {/* Sessions section */}
          <div>
            <div className="px-3 pt-3 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Sessions
            </div>
            {sessions.length === 0 && (
              <p className="px-3 py-2 text-xs text-gray-600">No sessions yet</p>
            )}
            {sessions.map(s => (
              <button
                key={s.id}
                onClick={() => handleSelect(s.id)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors',
                  activeSessionId === s.id
                    ? 'bg-gray-700 text-white'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200',
                )}
              >
                <MessageSquare size={12} className="shrink-0" />
                <span className="truncate">{s.label}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Auth warning banner */}
        {noAuth && (
          <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 bg-yellow-950 border-b border-yellow-800 text-yellow-300 text-sm">
            <AlertTriangle size={14} className="shrink-0" />
            <span>Auth Token 未设置，请求可能被拒绝</span>
            <button
              onClick={() => navigate('/config')}
              className="ml-auto text-xs underline hover:text-yellow-100"
            >
              前往 Config 配置 →
            </button>
            <button onClick={() => setNoAuth(false)} className="text-yellow-600 hover:text-yellow-400">✕</button>
          </div>
        )}

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
