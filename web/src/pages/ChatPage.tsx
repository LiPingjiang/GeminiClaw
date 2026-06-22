import { useCallback, useEffect, useRef, useState } from 'react'
import { Send, Square, Plus, MessageSquare, Cpu, AlertTriangle } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { streamChat, api, getConfig } from '@/lib/api'
import type { TuiEvent, Agent } from '@/lib/api'
import MessageBubble from '@/components/MessageBubble'
import ToolCallCard from '@/components/ToolCallCard'
import { cn } from '@/lib/utils'
interface SessionItem { id: string; label: string; agentName?: string }

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
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
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

  const loadAll = useCallback(async () => {
    const [rawSessions, agentList] = await Promise.all([api.getSessions(), api.getAgents()])
    // build session_id → agent map
    const agentBySession = new Map(agentList.filter(a => a.session_id).map(a => [a.session_id!, a]))
    setSessions(rawSessions.map(s => ({
      id: s.id,
      label: s.title ?? s.id.slice(0, 8) + '…',
      agentName: agentBySession.get(s.id)?.name,
    })))
    setAgents(agentList)
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

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

  const handleSelect = (id: string) => {
    resetChat()
    setActiveSessionId(id)
    // show loading indicator
    setItems([{ type: 'event', id: uid(), event: { kind: 'system', message: 'LOADING SESSION HISTORY…' } }])
    api.getSessionMessagesRaw(id).then(({ status, msgs }) => {
      if (status === 401) {
        setItems([{ type: 'event', id: uid(), event: { kind: 'error', message: 'AUTH TOKEN REQUIRED — go to Config and set your token' } }])
        setNoAuth(true)
        return
      }
      const loaded = msgs
        .filter((m: { role: string }) => m.role === 'user' || m.role === 'assistant')
        .map((m: { role: string; content: string }) => ({
          type: 'event' as const,
          id: uid(),
          event: m.role === 'user'
            ? { kind: 'user_message' as const, content: m.content }
            : { kind: 'response' as const, content: m.content },
        }))
      setItems(loaded.length > 0
        ? loaded
        : [{ type: 'event', id: uid(), event: { kind: 'system', message: 'NO MESSAGES IN THIS SESSION' } }]
      )
    })
  }

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

    const isNewSession = !activeSessionId  // capture before send
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
        // Register a new agent for this session (only if session was just created)
        if (isNewSession) {
          api.createSessionAgent(id).then(() => loadAll())
        } else {
          loadAll()
        }
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

  const filtered = selectedAgent
    ? sessions.filter(s => s.agentName === selectedAgent.name)
    : sessions

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

      {/* ── Left panel: unit roster + session log ── */}
      <aside style={{
        width: '13rem', flexShrink: 0, display: 'flex', flexDirection: 'column',
        background: 'var(--gc-panel)', borderRight: '1px solid var(--gc-border)', position: 'relative',
      }}>
        {/* Amber top bar */}
        <div style={{ height: 2, background: 'linear-gradient(90deg, var(--gc-accent) 40%, transparent)' }} />

        {/* New session button */}
        <div style={{ padding: '10px 10px 8px', borderBottom: '1px solid var(--gc-border)' }}>
          <button onClick={handleNew} className="sp-btn" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <Plus size={11} />
            NEW SESSION
          </button>
        </div>

        {/* Agent filter dropdown */}
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--gc-border)' }}>
          <div className="sp-label" style={{ padding: '0 0 4px', border: 'none' }}>◈ SELECT UNIT</div>
          <div style={{ position: 'relative' }}>
            <Cpu size={10} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: selectedAgent ? 'var(--gc-accent2)' : 'var(--gc-text-dim)', pointerEvents: 'none' }} />
            <select
              value={selectedAgent?.id ?? ''}
              onChange={e => {
                const id = e.target.value
                setSelectedAgent(agents.find(a => a.id === id) ?? null)
              }}
              style={{
                width: '100%', padding: '6px 8px 6px 24px',
                background: '#030609', border: '1px solid #0d3050',
                color: selectedAgent ? 'var(--gc-accent2)' : 'var(--gc-text-dim)',
                fontFamily: "'Share Tech Mono', monospace",
                fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase',
                cursor: 'pointer', outline: 'none', appearance: 'none',
                boxShadow: selectedAgent ? '0 0 6px var(--gc-accent2-glow)' : 'none',
                borderColor: selectedAgent ? 'var(--gc-accent2-dim)' : '#0d3050',
              }}
            >
              <option value="">ALL UNITS</option>
              {agents.map(a => (
                <option key={a.id} value={a.id}>{a.name.toUpperCase()}</option>
              ))}
            </select>
            {/* Custom arrow */}
            <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--gc-text-dim)', fontSize: 8, pointerEvents: 'none' }}>▼</span>
          </div>
        </div>

        {/* Session list */}
        <div className="sp-label" style={{ margin: '8px 0 0' }}>◈ SESSION LOG</div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
          {filtered.length === 0 && (
            <div style={{ padding: '12px 14px', fontSize: 9, color: 'var(--gc-text-dim)', letterSpacing: '0.1em' }}>
              NO RECORDS FOUND
            </div>
          )}
          {filtered.map(s => (
            <button
              key={s.id}
              onClick={() => handleSelect(s.id)}
              style={{
                width: '100%', display: 'flex', flexDirection: 'column',
                padding: '7px 14px', cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
                background: activeSessionId === s.id ? 'var(--gc-user-bg)' : 'transparent',
                borderLeft: `2px solid ${activeSessionId === s.id ? 'var(--gc-accent)' : 'transparent'}`,
                borderTop: 'none', borderRight: 'none', borderBottom: 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <MessageSquare size={10} style={{ color: activeSessionId === s.id ? 'var(--gc-accent)' : 'var(--gc-text-dim)', flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: activeSessionId === s.id ? 'var(--gc-accent)' : 'var(--gc-text-mid)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '0.05em' }}>
                  {s.label.toUpperCase()}
                </span>
              </div>
              {s.agentName && (
                <span style={{ marginLeft: 16, fontSize: 9, color: 'var(--gc-accent2-dim)', letterSpacing: '0.1em', marginTop: 2 }}>
                  UNIT: {s.agentName}
                </span>
              )}
            </button>
          ))}
        </div>
      </aside>

      {/* ── Main comm panel ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>

        {/* Subtle grid background */}
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0,
          backgroundImage: 'linear-gradient(var(--gc-grid-overlay) 1px, transparent 1px), linear-gradient(90deg, var(--gc-grid-overlay) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }} />

        {/* Auth warning */}
        {noAuth && (
          <div style={{
            flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10,
            padding: '7px 16px', zIndex: 1,
            background: 'var(--gc-error-bg)', borderBottom: '1px solid var(--gc-error-border)',
            fontSize: 10, letterSpacing: '0.12em', color: 'var(--gc-red)',
            textTransform: 'uppercase',
          }}>
            <AlertTriangle size={12} style={{ flexShrink: 0 }} />
            <span style={{ textShadow: '0 0 6px var(--gc-error-glow)' }}>⚠ AUTH TOKEN NOT SET — TRANSMISSIONS MAY FAIL</span>
            <button onClick={() => navigate('/config')}
              style={{ marginLeft: 'auto', fontSize: 9, color: '#ff6600', cursor: 'pointer', background: 'none', border: '1px solid var(--gc-error-border)', padding: '2px 8px' }}>
              CONFIG →
            </button>
            <button onClick={() => setNoAuth(false)}
              style={{ color: 'var(--gc-error-border)', cursor: 'pointer', background: 'none', border: 'none', fontSize: 12 }}>✕</button>
          </div>
        )}

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', position: 'relative', zIndex: 1 }}>
          {items.length === 0 && (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <div style={{ fontSize: 9, letterSpacing: '0.3em', color: 'var(--gc-border-hi)', textTransform: 'uppercase' }}>
                ◈ ◈ ◈ AWAITING TRANSMISSION ◈ ◈ ◈
              </div>
              <div className="blink" style={{ fontSize: 9, color: 'var(--gc-text-dim)', letterSpacing: '0.2em' }}>
                ENTER COMMAND BELOW
              </div>
            </div>
          )}
          {items.map(item => {
            if (item.type === 'event') return <MessageBubble key={item.id} event={item.event} />
            if (item.type === 'tool') return (
              <ToolCallCard key={item.id} name={item.tool.name}
                input={item.tool.input} output={item.tool.output} status={item.tool.status} />
            )
            if (item.type === 'streaming') return (
              <MessageBubble key={item.id} event={{ kind: 'response', content: streamingText }} streaming />
            )
            return null
          })}
          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div style={{
          flexShrink: 0, padding: '10px 16px 12px', zIndex: 1,
          borderTop: '1px solid var(--gc-border)',
          background: 'var(--gc-bg)',
          position: 'relative',
        }}>
          {/* Top amber line */}
          <div style={{ position: 'absolute', top: 0, left: '5%', right: '5%', height: 1,
            background: 'linear-gradient(90deg, transparent, var(--gc-accent-glow) 40%, var(--gc-accent-glow) 60%, transparent)' }} />

          <div style={{ fontSize: 8, letterSpacing: '0.2em', color: 'var(--gc-text-dim)', marginBottom: 6, textTransform: 'uppercase' }}>
            ▶ COMMAND INPUT {isStreaming && <span className="blink" style={{ color: 'var(--gc-accent)', marginLeft: 8 }}>■ TRANSMITTING</span>}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              className="sp-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
              }}
              placeholder="ENTER TRANSMISSION… (ENTER=SEND  SHIFT+ENTER=NEWLINE)"
              rows={1}
              style={{ flex: 1, resize: 'none', padding: '8px 12px', minHeight: 42, maxHeight: 160 }}
            />
            {isStreaming ? (
              <button onClick={handleCancel} className="sp-btn sp-btn-cyan" style={{ padding: '8px 14px' }} title="ABORT">
                <Square size={13} />
              </button>
            ) : (
              <button onClick={handleSend} disabled={!input.trim()} className="sp-btn" style={{ padding: '8px 14px' }}>
                <Send size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
