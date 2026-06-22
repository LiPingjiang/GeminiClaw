import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api, type Run } from '@/lib/api'

export default function RunsPage() {
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    setRuns(await api.getRuns())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const statusColor = (s: string) =>
    s === 'completed' ? 'var(--gc-green)' :
    s === 'running'   ? 'var(--gc-accent)' :
    s === 'failed'    ? 'var(--gc-red)' :
                        'var(--gc-text-dim)'

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto', background: 'var(--gc-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontSize: 9, letterSpacing: '0.2em', color: 'var(--gc-text-label)', textTransform: 'uppercase' }}>◈ OPERATION HISTORY</div>
        <button onClick={load} disabled={loading} className="sp-btn sp-btn-cyan" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={10} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          REFRESH
        </button>
      </div>

      <div style={{ border: '1px solid var(--gc-border)', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: "'Share Tech Mono', monospace" }}>
          <thead>
            <tr style={{ background: 'var(--gc-panel)' }}>
              {['Run ID', 'Status', 'Duration', 'Created'].map(h => (
                <th key={h} style={{ padding: '6px 14px', textAlign: 'left', fontSize: 9, letterSpacing: '0.15em', color: 'var(--gc-text-label)', textTransform: 'uppercase', borderBottom: '1px solid var(--gc-border)', fontWeight: 'normal' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={4} style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--gc-text-dim)', fontSize: 9, letterSpacing: '0.1em' }}>LOADING…</td></tr>
            )}
            {!loading && runs.length === 0 && (
              <tr><td colSpan={4} style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--gc-text-dim)', fontSize: 9, letterSpacing: '0.1em' }}>NO RUNS</td></tr>
            )}
            {runs.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid var(--gc-border)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-user-bg)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ padding: '8px 14px', color: 'var(--gc-text-dim)', fontSize: 10 }}>{r.id.slice(0, 12)}…</td>
                <td style={{ padding: '8px 14px' }}>
                  <span style={{ fontSize: 8, letterSpacing: '0.1em', textTransform: 'uppercase', color: statusColor(r.status), border: `1px solid ${statusColor(r.status)}`, padding: '1px 6px' }}>
                    {r.status}
                  </span>
                </td>
                <td style={{ padding: '8px 14px', color: 'var(--gc-text-mid)', fontSize: 10 }}>
                  {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}
                </td>
                <td style={{ padding: '8px 14px', color: 'var(--gc-text-dim)', fontSize: 10 }}>
                  {new Date(r.createdAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
