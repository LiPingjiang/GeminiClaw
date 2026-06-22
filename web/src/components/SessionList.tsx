import { MessageSquare, Plus } from 'lucide-react'

export interface SessionItem {
  id: string
  label: string
}

interface SessionListProps {
  sessions: SessionItem[]
  activeId: string | undefined
  onSelect: (id: string) => void
  onNew: () => void
}

export default function SessionList({ sessions, activeId, onSelect, onNew }: SessionListProps) {
  return (
    <aside style={{ width: '13rem', flexShrink: 0, display: 'flex', flexDirection: 'column', background: 'var(--gc-panel)', borderRight: '1px solid var(--gc-border)' }}>
      <div style={{ padding: '10px 10px 8px', borderBottom: '1px solid var(--gc-border)' }}>
        <button onClick={onNew} className="sp-btn" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <Plus size={11} />
          NEW SESSION
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {sessions.length === 0 && (
          <div style={{ fontSize: 9, color: 'var(--gc-text-dim)', textAlign: 'center', marginTop: 16, letterSpacing: '0.1em' }}>
            NO SESSIONS
          </div>
        )}
        {sessions.map(s => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              fontSize: 11,
              textAlign: 'left' as const,
              background: activeId === s.id ? 'var(--gc-user-bg)' : 'transparent',
              border: 'none',
              borderLeft: `2px solid ${activeId === s.id ? 'var(--gc-accent)' : 'transparent'}`,
              color: activeId === s.id ? 'var(--gc-accent)' : 'var(--gc-text-mid)',
              cursor: 'pointer',
              outline: 'none',
              fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}
          >
            <MessageSquare size={10} style={{ color: activeId === s.id ? 'var(--gc-accent)' : 'var(--gc-text-dim)', flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
          </button>
        ))}
      </div>
    </aside>
  )
}
