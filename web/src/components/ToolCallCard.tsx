import { useState } from 'react'
import { ChevronRight, ChevronDown, Wrench, CheckCircle, Loader } from 'lucide-react'

export interface ToolCallCardProps {
  name: string
  input?: unknown
  output?: unknown
  status: 'running' | 'done' | 'error'
}

export default function ToolCallCard({ name, input, output, status }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false)

  const statusColor =
    status === 'running' ? 'var(--gc-accent)' :
    status === 'done'    ? 'var(--gc-green)' :
                           'var(--gc-red)'

  return (
    <div style={{ margin: '6px 0', border: '1px solid var(--gc-border)', overflow: 'hidden', fontFamily: "'Share Tech Mono', monospace", fontSize: 11 }}>
      <button
        onClick={() => setExpanded(v => !v)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--gc-panel)', color: 'var(--gc-text)', textAlign: 'left', border: 'none', cursor: 'pointer' }}
      >
        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <Wrench size={10} style={{ color: 'var(--gc-accent2)', flexShrink: 0 }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--gc-text)' }}>{name}</span>
        {status === 'running' && <Loader size={10} style={{ color: 'var(--gc-accent)', animation: 'spin 1s linear infinite', flexShrink: 0 }} />}
        {status === 'done'    && <CheckCircle size={10} style={{ color: 'var(--gc-green)', flexShrink: 0 }} />}
        {status === 'error'   && <span style={{ color: 'var(--gc-red)', flexShrink: 0, fontSize: 10 }}>✗</span>}
      </button>
      {expanded && (
        <div style={{ display: 'grid', gridTemplateColumns: output !== undefined ? '1fr 1fr' : '1fr', borderTop: '1px solid var(--gc-border)' }}>
          <div style={{ padding: '8px 10px', background: 'var(--gc-panel-deep)', borderRight: output !== undefined ? '1px solid var(--gc-border)' : 'none' }}>
            <div style={{ fontSize: 8, letterSpacing: '0.15em', color: 'var(--gc-text-label)', textTransform: 'uppercase', marginBottom: 6 }}>Input</div>
            <pre style={{ margin: 0, color: 'var(--gc-assistant-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11 }}>
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
          {output !== undefined && (
            <div style={{ padding: '8px 10px', background: 'var(--gc-panel-deep)' }}>
              <div style={{ fontSize: 8, letterSpacing: '0.15em', color: 'var(--gc-text-label)', textTransform: 'uppercase', marginBottom: 6 }}>Output</div>
              <pre style={{ margin: 0, color: 'var(--gc-assistant-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11 }}>
                {typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
