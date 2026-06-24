import { useCallback, useEffect, useState } from 'react'
import { Trash2, RefreshCw, Sparkles } from 'lucide-react'
import { api, type Session } from '@/lib/api'

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setSessions(await api.getSessions())
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleDelete = async (id: string) => {
    await api.deleteSession(id)
    await load()
  }

  const handleGenerateTitle = async (id: string) => {
    setGenerating(prev => ({ ...prev, [id]: true }))
    try {
      const { title } = await api.generateSessionTitle(id)
      setSessions(prev => prev.map(s => s.id === id ? { ...s, title } : s))
    } catch {
      // ignore
    } finally {
      setGenerating(prev => ({ ...prev, [id]: false }))
    }
  }

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto', background: 'var(--gc-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontSize: 9, letterSpacing: '0.2em', color: 'var(--gc-text-label)', textTransform: 'uppercase' }}>◈ SESSION LOG</div>
        <button onClick={load} disabled={loading} className="sp-btn sp-btn-cyan" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={10} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          REFRESH
        </button>
      </div>

      <div style={{ border: '1px solid var(--gc-border)', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: "'Share Tech Mono', monospace" }}>
          <thead>
            <tr style={{ background: 'var(--gc-panel)' }}>
              {['Session ID', 'Title', 'Messages', 'Updated', '', ''].map(h => (
                <th key={h} style={{ padding: '6px 14px', textAlign: 'left', fontSize: 9, letterSpacing: '0.15em', color: 'var(--gc-text-label)', textTransform: 'uppercase', borderBottom: '1px solid var(--gc-border)', fontWeight: 'normal' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--gc-text-dim)', fontSize: 9, letterSpacing: '0.1em' }}>LOADING…</td></tr>
            )}
            {!loading && sessions.length === 0 && (
              <tr><td colSpan={5} style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--gc-text-dim)', fontSize: 9, letterSpacing: '0.1em' }}>NO SESSIONS</td></tr>
            )}
            {sessions.map(s => (
              <tr key={s.id} style={{ borderBottom: '1px solid var(--gc-border)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-user-bg)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ padding: '8px 14px', color: 'var(--gc-text-dim)', fontSize: 10 }}>{s.id.slice(0, 8)}…</td>
                <td style={{ padding: '8px 14px', color: 'var(--gc-text)' }}>{s.title ?? '(untitled)'}</td>
                <td style={{ padding: '8px 14px', color: 'var(--gc-text-mid)' }}>{s.message_count ?? '—'}</td>
                <td style={{ padding: '8px 14px', color: 'var(--gc-text-dim)', fontSize: 10 }}>{new Date(s.updated_at.replace(' ', 'T') + 'Z').toLocaleString()}</td>
                <td style={{ padding: '8px 14px' }}>
                  <button
                    onClick={() => handleGenerateTitle(s.id)}
                    disabled={generating[s.id]}
                    title="Generate title with AI"
                    style={{ background: 'none', border: 'none', cursor: generating[s.id] ? 'wait' : 'pointer', color: 'var(--gc-text-dim)', padding: 0, transition: 'color 0.15s' }}
                    onMouseEnter={e => { if (!generating[s.id]) (e.currentTarget.style.color = 'var(--gc-accent2)') }}
                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--gc-text-dim)')}
                  >
                    <Sparkles size={12} style={{ animation: generating[s.id] ? 'blink 1s step-end infinite' : 'none' }} />
                  </button>
                </td>
                <td style={{ padding: '8px 14px' }}>
                  <button onClick={() => handleDelete(s.id)} title="Delete session"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gc-text-dim)', padding: 0, transition: 'color 0.15s' }}
                    onMouseEnter={e => (e.currentTarget.style.color = 'var(--gc-red)')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--gc-text-dim)')}
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
