import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TuiEvent } from '@/lib/api'

interface MessageBubbleProps {
  event: TuiEvent & ({ kind: 'user_message' } | { kind: 'response' } | { kind: 'system' } | { kind: 'error' })
  streaming?: boolean
}

export default function MessageBubble({ event, streaming }: MessageBubbleProps) {
  if (event.kind === 'user_message') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <div style={{ maxWidth: '70%' }}>
          {/* Sender label */}
          <div style={{ textAlign: 'right', fontSize: 9, letterSpacing: '0.15em',
            color: '#7a5c20', marginBottom: 3, textTransform: 'uppercase' }}>
            ▶ OPERATOR INPUT
          </div>
          <div style={{
            background: 'rgba(255,140,0,0.08)',
            border: '1px solid #ff8c00',
            borderTopRightRadius: 0,
            padding: '8px 12px',
            fontSize: 13,
            color: '#ff8c00',
            lineHeight: 1.6,
            position: 'relative',
            boxShadow: '0 0 8px rgba(255,140,0,0.15), inset 0 0 6px rgba(255,140,0,0.04)',
          }}>
            {event.content}
            {/* Corner accent */}
            <span style={{ position: 'absolute', top: -1, right: -1, width: 6, height: 6,
              borderTop: '2px solid #ff8c00', borderRight: '2px solid #ff8c00' }} />
          </div>
        </div>
      </div>
    )
  }

  if (event.kind === 'response') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 16 }}>
        <div style={{ maxWidth: '80%' }}>
          {/* Sender label */}
          <div style={{ fontSize: 9, letterSpacing: '0.15em', color: '#004455',
            marginBottom: 3, textTransform: 'uppercase' }}>
            ◀ UNIT-GEMINI /{' '}
            {streaming
              ? <span className="blink" style={{ color: '#00d4ff' }}>TRANSMITTING</span>
              : <span style={{ color: '#00cc66' }}>COMPLETE</span>
            }
          </div>
          <div style={{
            background: 'rgba(0,212,255,0.04)',
            border: '1px solid #0d3a4a',
            borderTopLeftRadius: 0,
            padding: '8px 12px',
            fontSize: 13,
            color: '#b0d0d8',
            lineHeight: 1.6,
            position: 'relative',
            boxShadow: '0 0 8px rgba(0,212,255,0.08), inset 0 0 6px rgba(0,212,255,0.02)',
          }}>
            {streaming ? (
              <span>
                {event.content}
                <span className="blink" style={{
                  display: 'inline-block', width: 8, height: 14,
                  background: '#00d4ff', marginLeft: 2, verticalAlign: 'middle',
                  boxShadow: '0 0 6px #00d4ff',
                }} />
              </span>
            ) : (
              <div className="prose-space">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content}</ReactMarkdown>
              </div>
            )}
            {/* Corner accent */}
            <span style={{ position: 'absolute', bottom: -1, left: -1, width: 6, height: 6,
              borderBottom: '2px solid #00d4ff', borderLeft: '2px solid #00d4ff', opacity: 0.6 }} />
          </div>
        </div>
      </div>
    )
  }

  if (event.kind === 'system') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <div style={{
          fontSize: 9, letterSpacing: '0.15em', color: '#3d5060', textTransform: 'uppercase',
          padding: '3px 12px', border: '1px solid #0d2a40',
          background: '#060d1a',
        }}>
          ◈ SYS — {event.message}
        </div>
      </div>
    )
  }

  if (event.kind === 'error') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <div style={{
          fontSize: 9, letterSpacing: '0.15em', color: '#ff4400', textTransform: 'uppercase',
          padding: '3px 12px', border: '1px solid #661100',
          background: '#1a0500',
          textShadow: '0 0 6px rgba(255,68,0,0.6)',
        }}>
          ⚠ ALERT — {event.message}
        </div>
      </div>
    )
  }

  return null
}
