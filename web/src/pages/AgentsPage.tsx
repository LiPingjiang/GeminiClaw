import { useEffect, useState } from 'react'
import { Cpu, RefreshCw } from 'lucide-react'
import { api, type Agent } from '@/lib/api'

function groupByName(agents: import('@/lib/api').Agent[]) {
  const map = new Map<string, { name: string; count: number; status: string; lastActive?: string }>()
  for (const a of agents) {
    const existing = map.get(a.name)
    if (!existing) {
      map.set(a.name, { name: a.name, count: 1, status: a.status, lastActive: a.lastActive })
    } else {
      existing.count++
      if (a.status === 'active') existing.status = 'active'
      if (a.lastActive && (!existing.lastActive || a.lastActive > existing.lastActive))
        existing.lastActive = a.lastActive
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    setAgents(await api.getAgents())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const statusColor = (status: string) =>
    status === 'active' ? 'var(--gc-green)' :
    status === 'idle'   ? 'var(--gc-text-dim)' :
                          'var(--gc-text-dim)'

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto', background: 'var(--gc-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontSize: 9, letterSpacing: '0.2em', color: 'var(--gc-text-label)', textTransform: 'uppercase' }}>◈ UNIT REGISTRY</div>
        <button onClick={load} disabled={loading} className="sp-btn sp-btn-cyan" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={10} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          REFRESH
        </button>
      </div>

      {loading && <div style={{ fontSize: 9, color: 'var(--gc-text-dim)', letterSpacing: '0.1em' }}>LOADING…</div>}

      {!loading && agents.length === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 60, color: 'var(--gc-text-dim)' }}>
          <Cpu size={32} style={{ marginBottom: 12, opacity: 0.3 }} />
          <div style={{ fontSize: 9, letterSpacing: '0.15em', textTransform: 'uppercase' }}>NO UNITS ACTIVE</div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
        {groupByName(agents).map(g => (
          <div key={g.name} style={{ background: 'var(--gc-panel)', border: '1px solid var(--gc-border)', padding: 14, position: 'relative', transition: 'border-color 0.15s' }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--gc-border-hi)')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <Cpu size={14} style={{ color: 'var(--gc-accent2)', flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--gc-text)', fontFamily: "'Share Tech Mono', monospace" }}>{g.name}</span>
              <span style={{ fontSize: 8, letterSpacing: '0.1em', textTransform: 'uppercase', color: statusColor(g.status), border: `1px solid ${statusColor(g.status)}`, padding: '1px 6px', flexShrink: 0 }}>
                {g.status}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, paddingLeft: 24 }}>
              {g.count > 1 && (
                <div style={{ fontSize: 9, color: 'var(--gc-accent2-dim)', letterSpacing: '0.08em' }}>
                  {g.count} SESSIONS
                </div>
              )}
              {g.lastActive && (
                <div style={{ fontSize: 9, color: 'var(--gc-text-dim)', letterSpacing: '0.05em' }}>
                  {new Date(g.lastActive.replace(' ', 'T') + 'Z').toLocaleString()}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
