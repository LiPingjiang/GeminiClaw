import { useEffect, useState } from 'react'
import { RefreshCw, AlertCircle } from 'lucide-react'
import { api } from '@/lib/api'

type SubagentRun = {
  run_id: string
  parent_session_id: string
  task_titles: string
  status: string
  started_at: number
  completed_at?: number
  error?: string
}

export default function RunsPage() {
  const [runs, setRuns] = useState<SubagentRun[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    setRuns(await api.getSubagentRuns())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const statusColor = (s: string) =>
    s === 'completed' ? 'var(--gc-green)' :
    s === 'running'   ? 'var(--gc-accent)' :
    s === 'failed'    ? 'var(--gc-red)' :
                        'var(--gc-text-dim)'

  const fmt = (ms: number) => new Date(ms).toLocaleString()
  const duration = (r: SubagentRun) =>
    r.completed_at ? `${((r.completed_at - r.started_at) / 1000).toFixed(1)}s` : '—'

  const parseTitles = (raw: string): string[] => {
    try { return JSON.parse(raw) } catch { return [raw] }
  }

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto', background: 'var(--gc-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 9, letterSpacing: '0.2em', color: 'var(--gc-text-label)', textTransform: 'uppercase' }}>◈ SUBAGENT RUNS</div>
        <button onClick={load} disabled={loading} className="sp-btn sp-btn-cyan" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={10} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          REFRESH
        </button>
      </div>

      {/* 说明 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 12px', background: 'var(--gc-panel)', border: '1px solid var(--gc-border)', marginBottom: 16, fontSize: 10, color: 'var(--gc-text-dim)', lineHeight: 1.6 }}>
        <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 1, color: 'var(--gc-accent2-dim)' }} />
        <div>
          此页面显示 <strong style={{ color: 'var(--gc-text)' }}>多 agent 委派运行记录</strong>（delegate_tasks 工具触发，持久化于 SQLite）。<br />
          普通 QQ bot 对话历史在 Sessions 页。通过 /v1/runs 接口触发的异步 API 运行仅在内存中，重启后清空，不在此显示。
        </div>
      </div>

      <div style={{ border: '1px solid var(--gc-border)', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: "'Share Tech Mono', monospace" }}>
          <thead>
            <tr style={{ background: 'var(--gc-panel)' }}>
              {['Run ID', 'Tasks', 'Status', 'Duration', 'Started'].map(h => (
                <th key={h} style={{ padding: '6px 14px', textAlign: 'left', fontSize: 9, letterSpacing: '0.15em', color: 'var(--gc-text-label)', textTransform: 'uppercase', borderBottom: '1px solid var(--gc-border)', fontWeight: 'normal' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--gc-text-dim)', fontSize: 9 }}>LOADING…</td></tr>
            )}
            {!loading && runs.length === 0 && (
              <tr><td colSpan={5} style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--gc-text-dim)', fontSize: 9 }}>NO SUBAGENT RUNS — delegate_tasks 尚未触发过</td></tr>
            )}
            {runs.map(r => (
              <tr key={r.run_id} style={{ borderBottom: '1px solid var(--gc-border)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-user-bg)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ padding: '8px 14px', color: 'var(--gc-text-dim)', fontSize: 10 }}>{r.run_id.slice(0, 14)}…</td>
                <td style={{ padding: '8px 14px', color: 'var(--gc-text)', maxWidth: 300 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10 }}>
                    {parseTitles(r.task_titles).join(' · ')}
                  </div>
                </td>
                <td style={{ padding: '8px 14px' }}>
                  <span style={{ fontSize: 8, letterSpacing: '0.1em', textTransform: 'uppercase', color: statusColor(r.status), border: `1px solid ${statusColor(r.status)}`, padding: '1px 6px' }}>
                    {r.status}
                  </span>
                </td>
                <td style={{ padding: '8px 14px', color: 'var(--gc-text-mid)', fontSize: 10 }}>{duration(r)}</td>
                <td style={{ padding: '8px 14px', color: 'var(--gc-text-dim)', fontSize: 10 }}>{fmt(r.started_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
