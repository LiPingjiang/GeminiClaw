import { useEffect, useState } from 'react'
import { Cpu, RefreshCw, Copy, Archive, X, ExternalLink } from 'lucide-react'
import { api, type Agent } from '@/lib/api'

type AgentDetail = Agent & { session_id?: string; template_name?: string; description?: string; depth?: number }

function groupByName(agents: Agent[]) {
  const map = new Map<string, { name: string; count: number; status: string; lastActive?: string; ids: string[] }>()
  for (const a of agents) {
    const existing = map.get(a.name)
    if (!existing) {
      map.set(a.name, { name: a.name, count: 1, status: a.status, lastActive: a.lastActive, ids: [a.id] })
    } else {
      existing.count++
      existing.ids.push(a.id)
      if (a.status === 'active') existing.status = 'active'
      if (a.lastActive && (!existing.lastActive || a.lastActive > existing.lastActive))
        existing.lastActive = a.lastActive
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const statusColor = (s: string) =>
  s === 'active' ? 'var(--gc-green)' :
  s === 'archived' ? 'var(--gc-text-dim)' :
                     'var(--gc-text-dim)'

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<AgentDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [saving, setSaving] = useState(false)
  const [copying, setCopying] = useState(false)
  const [tab, setTab] = useState<'config' | 'prompt' | 'skills'>('config')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [promptLoading, setPromptLoading] = useState(false)
  const [skills, setSkills] = useState<Array<{ name: string; description: string; enabled: boolean }>>([])
  const [skillsLoading, setSkillsLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    setAgents(await api.getAgents())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const openDetail = async (id: string) => {
    setSelectedId(id)
    setTab('config')
    setSystemPrompt('')
    setDetailLoading(true)
    try {
      const d = await api.getAgent(id)
      setDetail(d)
      setEditName(d.name)
      setEditDesc(d.description ?? '')
    } catch {
      setDetail(null)
    }
    setDetailLoading(false)
  }

  const loadPrompt = async () => {
    if (!detail) return
    setPromptLoading(true)
    try {
      const r = await api.getAgentSystemPrompt(detail.id)
      setSystemPrompt(r.systemPrompt)
    } catch { setSystemPrompt('(error loading)') }
    setPromptLoading(false)
  }

  const loadSkills = async () => {
    setSkillsLoading(true)
    setSkills(await api.getSkills())
    setSkillsLoading(false)
  }

  const switchTab = (t: 'config' | 'prompt' | 'skills') => {
    setTab(t)
    if (t === 'prompt' && !systemPrompt) loadPrompt()
    if (t === 'skills' && skills.length === 0) loadSkills()
  }

  const saveDetail = async () => {
    if (!detail) return
    setSaving(true)
    await api.updateAgent(detail.id, { agent_name: editName.trim() || detail.name, description: editDesc })
    await load()
    setSaving(false)
  }

  const archiveAgent = async () => {
    if (!detail) return
    await api.updateAgent(detail.id, { status: 'archived' })
    setSelectedId(null)
    setDetail(null)
    await load()
  }

  const copyAgent = async () => {
    if (!detail) return
    setCopying(true)
    try {
      const { sessionId } = await api.createSession()
      await api.createSessionAgent(sessionId, detail.template_name ?? 'base', detail.name)
      await load()
    } catch { /* ignore */ }
    setCopying(false)
  }

  const grouped = groupByName(agents.filter(a => a.status !== 'archived'))
  const archived = agents.filter(a => a.status === 'archived')

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* ── Agent list ── */}
      <div style={{ flex: 1, padding: 24, overflowY: 'auto', background: 'var(--gc-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontSize: 9, letterSpacing: '0.2em', color: 'var(--gc-text-label)', textTransform: 'uppercase' }}>◈ UNIT REGISTRY</div>
          <button onClick={load} disabled={loading} className="sp-btn sp-btn-cyan" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={10} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
            REFRESH
          </button>
        </div>

        {loading && <div style={{ fontSize: 9, color: 'var(--gc-text-dim)', letterSpacing: '0.1em' }}>LOADING…</div>}

        {/* Active agents (grouped by name) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
          {grouped.map(g => (
            <div key={g.name}
              onClick={() => openDetail(g.ids[0])}
              style={{ background: selectedId === g.ids[0] ? 'var(--gc-user-bg)' : 'var(--gc-panel)', border: `1px solid ${selectedId === g.ids[0] ? 'var(--gc-accent)' : 'var(--gc-border)'}`, padding: 14, cursor: 'pointer', transition: 'border-color 0.15s' }}
              onMouseEnter={e => { if (selectedId !== g.ids[0]) (e.currentTarget as HTMLElement).style.borderColor = 'var(--gc-border-hi)' }}
              onMouseLeave={e => { if (selectedId !== g.ids[0]) (e.currentTarget as HTMLElement).style.borderColor = 'var(--gc-border)' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <Cpu size={14} style={{ color: 'var(--gc-accent2)', flexShrink: 0 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--gc-text)', fontFamily: "'Share Tech Mono', monospace" }}>{g.name}</span>
                <span style={{ fontSize: 8, letterSpacing: '0.1em', textTransform: 'uppercase', color: statusColor(g.status), border: `1px solid ${statusColor(g.status)}`, padding: '1px 6px', flexShrink: 0 }}>{g.status}</span>
              </div>
              <div style={{ paddingLeft: 24, fontSize: 9, color: 'var(--gc-text-dim)', display: 'flex', gap: 12 }}>
                {g.count > 1 && <span>{g.count} sessions</span>}
                {g.lastActive && <span>{new Date(g.lastActive.replace(' ', 'T') + 'Z').toLocaleDateString()}</span>}
              </div>
            </div>
          ))}
        </div>

        {/* Archived section */}
        {archived.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 9, letterSpacing: '0.15em', color: 'var(--gc-text-dim)', textTransform: 'uppercase', marginBottom: 10 }}>◈ ARCHIVED ({archived.length})</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
              {archived.map(a => (
                <div key={a.id}
                  onClick={() => openDetail(a.id)}
                  style={{ background: 'var(--gc-panel)', border: '1px solid var(--gc-border)', padding: 14, cursor: 'pointer', opacity: 0.6 }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Cpu size={12} style={{ color: 'var(--gc-text-dim)' }} />
                    <span style={{ fontSize: 11, color: 'var(--gc-text-dim)', fontFamily: "'Share Tech Mono', monospace" }}>{a.name}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 8, color: 'var(--gc-text-dim)', border: '1px solid var(--gc-border)', padding: '1px 5px' }}>archived</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {!loading && agents.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 60, color: 'var(--gc-text-dim)' }}>
            <Cpu size={32} style={{ marginBottom: 12, opacity: 0.3 }} />
            <div style={{ fontSize: 9, letterSpacing: '0.15em', textTransform: 'uppercase' }}>NO UNITS ACTIVE</div>
          </div>
        )}
      </div>

      {/* ── Detail panel ── */}
      {selectedId && (
        <div style={{ width: 320, borderLeft: '1px solid var(--gc-border)', background: 'var(--gc-panel)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--gc-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 0 }}>
              {(['config', 'prompt', 'skills'] as const).map(t => (
                <button key={t} onClick={() => switchTab(t)}
                  style={{ background: 'none', border: 'none', borderBottom: `2px solid ${tab === t ? 'var(--gc-accent)' : 'transparent'}`, cursor: 'pointer', color: tab === t ? 'var(--gc-accent)' : 'var(--gc-text-dim)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '4px 10px' }}>
                  {t === 'config' ? 'CONFIG' : t === 'prompt' ? 'PROMPT' : 'SKILLS'}
                </button>
              ))}
            </div>
            <button onClick={() => { setSelectedId(null); setDetail(null) }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gc-text-dim)', padding: 0 }}>
              <X size={14} />
            </button>
          </div>

          {detailLoading && <div style={{ padding: 20, fontSize: 9, color: 'var(--gc-text-dim)', letterSpacing: '0.1em' }}>LOADING…</div>}

          {detail && !detailLoading && tab === 'prompt' && (
            <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
              {promptLoading
                ? <div style={{ fontSize: 9, color: 'var(--gc-text-dim)' }}>GENERATING…</div>
                : systemPrompt
                  ? <pre style={{ margin: 0, fontSize: 10, color: 'var(--gc-assistant-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6, fontFamily: "'Share Tech Mono', monospace" }}>{systemPrompt}</pre>
                  : <button onClick={loadPrompt} className="sp-btn sp-btn-cyan" style={{ fontSize: 9 }}>LOAD PROMPT</button>
              }
            </div>
          )}

          {detail && !detailLoading && tab === 'skills' && (
            <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
              {skillsLoading
                ? <div style={{ fontSize: 9, color: 'var(--gc-text-dim)' }}>LOADING…</div>
                : skills.length === 0
                  ? <div style={{ fontSize: 9, color: 'var(--gc-text-dim)' }}>暂无技能（skills/ 目录为空）</div>
                  : skills.map(sk => (
                      <div key={sk.name} style={{ marginBottom: 10, padding: 10, background: 'var(--gc-panel-deep)', border: '1px solid var(--gc-border)' }}>
                        <div style={{ fontSize: 10, color: 'var(--gc-accent2)', marginBottom: 3 }}>{sk.name}</div>
                        <div style={{ fontSize: 9, color: 'var(--gc-text-dim)', lineHeight: 1.5 }}>{sk.description}</div>
                        <div style={{ marginTop: 6, fontSize: 8, color: 'var(--gc-green)', letterSpacing: '0.1em' }}>✅ ACTIVE (global)</div>
                      </div>
                    ))
              }
              <div style={{ marginTop: 12, fontSize: 8, color: 'var(--gc-text-dim)', letterSpacing: '0.05em', lineHeight: 1.6 }}>
                技能当前全局启用。per-agent 技能开关需要架构支持（规划中）。
              </div>
            </div>
          )}

          {detail && !detailLoading && tab === 'config' && (
            <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
              {/* Fields */}
              {[
                ['ID', detail.id.slice(0, 16) + '…'],
                ['Template', detail.template_name ?? 'base'],
                ['Depth', String(detail.depth ?? 0)],
                ['Status', detail.status],
                ['Created', detail.lastActive ? new Date(detail.lastActive.replace(' ', 'T') + 'Z').toLocaleString() : '—'],
              ].map(([label, value]) => (
                <div key={label} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 8, letterSpacing: '0.15em', color: 'var(--gc-text-label)', textTransform: 'uppercase', marginBottom: 3 }}>{label}</div>
                  <div style={{ fontSize: 11, color: 'var(--gc-text-dim)', fontFamily: "'Share Tech Mono', monospace" }}>{value}</div>
                </div>
              ))}

              {/* Session link */}
              {detail.session_id && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 8, letterSpacing: '0.15em', color: 'var(--gc-text-label)', textTransform: 'uppercase', marginBottom: 3 }}>Session</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--gc-accent2)', fontFamily: "'Share Tech Mono', monospace" }}>
                    {detail.session_id.slice(0, 12)}…
                    <ExternalLink size={10} style={{ cursor: 'pointer' }} onClick={() => window.location.hash = '#/comm'} />
                  </div>
                </div>
              )}

              {/* Editable fields */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 8, letterSpacing: '0.15em', color: 'var(--gc-text-label)', textTransform: 'uppercase', marginBottom: 5 }}>Name</div>
                <input className="sp-input" value={editName} onChange={e => setEditName(e.target.value)}
                  style={{ width: '100%', padding: '5px 8px', fontSize: 11 }} />
              </div>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 8, letterSpacing: '0.15em', color: 'var(--gc-text-label)', textTransform: 'uppercase', marginBottom: 5 }}>Description</div>
                <textarea className="sp-input" value={editDesc} onChange={e => setEditDesc(e.target.value)}
                  rows={3} style={{ width: '100%', padding: '5px 8px', fontSize: 11, resize: 'vertical' }} />
              </div>

              <button onClick={saveDetail} disabled={saving} className="sp-btn" style={{ width: '100%', marginBottom: 8 }}>
                {saving ? 'SAVING…' : 'SAVE'}
              </button>

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={copyAgent} disabled={copying} className="sp-btn sp-btn-cyan" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                  <Copy size={11} />
                  {copying ? '…' : 'COPY'}
                </button>
                <button onClick={archiveAgent} className="sp-btn" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, borderColor: 'var(--gc-text-dim)', color: 'var(--gc-text-dim)' }}>
                  <Archive size={11} />
                  ARCHIVE
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
