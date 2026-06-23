import { useState, useCallback, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { Copy, Check } from 'lucide-react'
import type { TuiEvent } from '@/lib/api'

// ── Code block with language label + copy button ─────────────────────────────

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => undefined)
  }, [code])

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-lang">{language.toUpperCase()}</span>
        <button className="code-copy-btn" onClick={handleCopy} title="Copy">
          {copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
      </div>
      <pre className="code-block-pre"><code>{code}</code></pre>
    </div>
  )
}

// ── react-markdown component overrides ───────────────────────────────────────

const MD_COMPONENTS: Components = {
  // Block code: extract language, render with header + copy button
  code({ children, className }) {
    const match = /language-(\w+)/.exec(className ?? '')
    const code = String(children).replace(/\n$/, '')
    // Block if has language class OR multi-line (unlabeled fenced block)
    if (match || code.includes('\n')) {
      return <CodeBlock language={match?.[1] ?? ''} code={code} />
    }
    // Inline code — keep existing prose-space styling via CSS
    return <code className={className}>{children}</code>
  },
  // Let code component own the full block rendering
  pre({ children }) {
    return <>{children}</>
  },
  // del element for ~~strikethrough~~ (GFM)
  del({ children }) {
    return <del>{children}</del>
  },
}

// ── Shared markdown renderer ─────────────────────────────────────────────────

function ProseMarkdown({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <div className={streaming ? 'prose-space streaming' : 'prose-space'}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

// ── Thinking indicator ───────────────────────────────────────────────────────

const THINKING_PHRASES = [
  '正在思考…',
  '分析上下文…',
  '整理思路…',
  '构思回复…',
  '深入理解中…',
  '处理请求…',
]

const TOOL_PHRASES: Record<string, string> = {
  EXECUTING:   '调用终端工具排查…',
  READING:     '读取文件内容…',
  WRITING:     '写入文件…',
  EDITING:     '修改代码…',
  SEARCHING:   '搜索代码库…',
  FETCHING:    '访问网络资源…',
  DISPATCHING: '派遣子智能体…',
}

function ThinkingIndicator({ toolStatus }: { toolStatus: string }) {
  const [phraseIdx, setPhraseIdx] = useState(0)
  const [visible, setVisible] = useState(true)

  const isThinking = toolStatus === 'TRANSMITTING'

  useEffect(() => {
    if (!isThinking) { setVisible(true); return }
    const cycle = setInterval(() => {
      setVisible(false)
      setTimeout(() => {
        setPhraseIdx(i => (i + 1) % THINKING_PHRASES.length)
        setVisible(true)
      }, 250)
    }, 2800)
    return () => clearInterval(cycle)
  }, [isThinking])

  const text = isThinking
    ? THINKING_PHRASES[phraseIdx]
    : (TOOL_PHRASES[toolStatus] ?? toolStatus.toLowerCase() + '…')

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 24, padding: '2px 0' }}>
      <span className="blink" style={{
        display: 'inline-block',
        width: 8,
        height: 15,
        background: 'var(--gc-accent2)',
        boxShadow: '0 0 8px var(--gc-accent2)',
        flexShrink: 0,
      }} />
      <span style={{
        fontSize: 12,
        color: 'var(--gc-accent2)',
        letterSpacing: '0.05em',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.2s ease',
        textShadow: '0 0 6px var(--gc-accent2-glow)',
      }}>
        {text}
      </span>
    </div>
  )
}

// ── MessageBubble ────────────────────────────────────────────────────────────

interface MessageBubbleProps {
  event: TuiEvent & ({ kind: 'user_message' } | { kind: 'response' } | { kind: 'system' } | { kind: 'error' })
  streaming?: boolean
  streamingStatus?: string
}

export default function MessageBubble({ event, streaming, streamingStatus }: MessageBubbleProps) {
  if (event.kind === 'user_message') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <div style={{ maxWidth: '70%' }}>
          <div style={{ textAlign: 'right', fontSize: 9, letterSpacing: '0.15em', color: 'var(--gc-text-label)', marginBottom: 3, textTransform: 'uppercase' }}>
            ▶ OPERATOR INPUT
          </div>
          <div style={{
            background: 'var(--gc-user-bg)',
            border: '1px solid var(--gc-user-border)',
            borderTopRightRadius: 0,
            padding: '8px 12px',
            fontSize: 13,
            color: 'var(--gc-user-text)',
            lineHeight: 1.6,
            position: 'relative',
            boxShadow: '0 0 8px var(--gc-user-glow), inset 0 0 6px var(--gc-user-glow)',
          }}>
            {event.content}
            <span style={{ position: 'absolute', top: -1, right: -1, width: 6, height: 6, borderTop: '2px solid var(--gc-user-border)', borderRight: '2px solid var(--gc-user-border)' }} />
          </div>
        </div>
      </div>
    )
  }

  if (event.kind === 'response') {
    const isEmpty = streaming && !event.content.trim()
    const statusLabel = streamingStatus ?? 'TRANSMITTING'
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 16 }}>
        <div style={{ maxWidth: '80%' }}>
          <div style={{ fontSize: 9, letterSpacing: '0.15em', color: 'var(--gc-accent2-dim)', marginBottom: 3, textTransform: 'uppercase' }}>
            ◀ UNIT-GEMINI /{' '}
            {streaming
              ? <span className="blink" style={{ color: 'var(--gc-accent2)' }}>{statusLabel}</span>
              : <span style={{ color: 'var(--gc-green)' }}>COMPLETE</span>
            }
          </div>
          <div style={{
            background: 'var(--gc-assistant-bg)',
            border: '1px solid var(--gc-assistant-border)',
            borderTopLeftRadius: 0,
            padding: '8px 12px',
            fontSize: 13,
            color: 'var(--gc-assistant-text)',
            lineHeight: 1.6,
            position: 'relative',
            boxShadow: '0 0 8px var(--gc-assistant-glow), inset 0 0 6px var(--gc-assistant-glow)',
          }}>
            {isEmpty ? (
              <ThinkingIndicator toolStatus={streamingStatus ?? 'TRANSMITTING'} />
            ) : (
              <ProseMarkdown content={event.content} streaming={streaming} />
            )}
            <span style={{ position: 'absolute', bottom: -1, left: -1, width: 6, height: 6, borderBottom: '2px solid var(--gc-accent2)', borderLeft: '2px solid var(--gc-accent2)', opacity: 0.6 }} />
          </div>
        </div>
      </div>
    )
  }

  if (event.kind === 'system') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 9, letterSpacing: '0.15em', color: 'var(--gc-sys-text)', textTransform: 'uppercase', padding: '3px 12px', border: '1px solid var(--gc-sys-border)', background: 'var(--gc-sys-bg)' }}>
          ◈ SYS — {event.message}
        </div>
      </div>
    )
  }

  if (event.kind === 'error') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 9, letterSpacing: '0.15em', color: 'var(--gc-red)', textTransform: 'uppercase', padding: '3px 12px', border: '1px solid var(--gc-error-border)', background: 'var(--gc-error-bg)', textShadow: '0 0 6px var(--gc-error-glow)' }}>
          ⚠ ALERT — {event.message}
        </div>
      </div>
    )
  }

  return null
}
