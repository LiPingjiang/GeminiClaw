import { useEffect, useState } from 'react'
import { Cpu, RefreshCw, Copy, Archive, X, ExternalLink, ChevronDown, ChevronRight, Lock, Edit3 } from 'lucide-react'
import { api, type Agent } from '@/lib/api'

// ── Structured Prompt Layer Viewer ────────────────────────────────────────────
type PromptData = Awaited<ReturnType<typeof api.getAgentSystemPrompt>>

function LayerBlock({ label, editable, chars, note, children, defaultOpen = false }: {
  label: string; editable: boolean; chars: number; note?: string; children?: React.ReactNode; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ marginBottom: 10, border: '1px solid var(--gc-border)', overflow: 'hidden' }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'var(--gc-panel)', cursor: 'pointer', userSelect: 'none' }}
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span style={{ flex: 1, fontSize: 9, letterSpacing: '0.1em', color: 'var(--gc-text)', textTransform: 'uppercase' }}>{label}</span>
        {editable
          ? <Edit3 size={9} style={{ color: 'var(--gc-accent2)' }} />
          : <Lock size={9} style={{ color: 'var(--gc-text-dim)' }} />}
        <span style={{ fontSize: 8, color: 'var(--gc-text-dim)', marginLeft: 4 }}>{chars > 0 ? `${chars}c` : 'empty'}</span>
      </div>
      {note && <div style={{ padding: '3px 10px', fontSize: 8, color: 'var(--gc-accent2-dim)', background: 'var(--gc-panel-deep)', borderBottom: '1px solid var(--gc-border)' }}>{note}</div>}
      {open && children && <div style={{ padding: 10, background: 'var(--gc-panel-deep)' }}>{children}</div>}
    </div>
  )
}

function ContentPre({ text, empty }: { text: string; empty?: string }) {
  if (!text) return <span style={{ fontSize: 9, color: 'var(--gc-text-dim)', fontStyle: 'italic' }}>{empty ?? '(empty)'}</span>
  return <pre style={{ margin: 0, fontSize: 9, color: 'var(--gc-assistant-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5, fontFamily: "'Share Tech Mono', monospace" }}>{text}</pre>
}

function StructuredPrompt({ data }: { data: PromptData }) {
  const { layers, model, modelFamily, totalChars, architectureLimits } = data
  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 10, padding: '6px 10px', background: 'var(--gc-panel)', border: '1px solid var(--gc-border)', fontSize: 9, color: 'var(--gc-text-dim)' }}>
        <span style={{ color: 'var(--gc-text)' }}>Model:</span> {model}
        <span style={{ marginLeft: 10, color: 'var(--gc-text)' }}>Family:</span> {modelFamily}
        <span style={{ marginLeft: 10, color: 'var(--gc-text)' }}>Total:</span> {totalChars.toLocaleString()} chars → Claude
      </div>

      {/* Layer 0: Code constants */}
      <LayerBlock label={layers.constants.label} editable={false}
        chars={layers.constants.items.reduce((s, i) => s + i.chars, 0)}
        note="src/system-prompt/constants.ts（版本控制，需改代码）">
        {layers.constants.items.map(item => (
          <div key={item.name} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 3 }}>
              <span style={{ fontSize: 8, color: 'var(--gc-accent)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>{item.name}</span>
              <span style={{ fontSize: 8, color: 'var(--gc-text-dim)' }}>{item.scope}</span>
              <span style={{ fontSize: 8, color: 'var(--gc-text-dim)', marginLeft: 'auto' }}>{item.chars}c</span>
            </div>
            <ContentPre text={item.content} />
          </div>
        ))}
      </LayerBlock>

      {/* Layer 1: Global identity */}
      <LayerBlock label={layers.globalIdentity.label} editable={true}
        chars={layers.globalIdentity.chars}
        note={`${layers.globalIdentity.file} | Config > AGENT.MD 页面修改`}
        defaultOpen>
        <ContentPre text={layers.globalIdentity.content} empty="（文件为空）" />
      </LayerBlock>

      {/* Layer 2: Agent fixed memory */}
      <LayerBlock label={layers.agentFixed.label} editable={true}
        chars={layers.agentFixed.chars}
        note={`${layers.agentFixed.file}${layers.agentFixed.exists ? '' : ' [不存在，需先创建]'} | Agents > CONFIG 面板修改`}>
        <ContentPre text={layers.agentFixed.content} empty="（未设置 agent 专属身份）" />
      </LayerBlock>

      {/* Layer 3: Non-fixed memory */}
      <div style={{ marginBottom: 10, border: '1px solid var(--gc-border)' }}>
        <div style={{ padding: '6px 10px', background: 'var(--gc-panel)', fontSize: 9, color: 'var(--gc-text)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          {layers.memory.label}
        </div>
        {layers.memory.items.map(item => (
          <LayerBlock key={item.name} label={item.name} editable={item.editable}
            chars={item.chars}
            note={`${item.file}${item.exists ? '' : ' [不存在]'}${!item.editable ? ' | 只读，由 triage 自动写入' : ''}`}>
            <ContentPre text={item.content} empty="（空）" />
          </LayerBlock>
        ))}
      </div>

      {/* Layer 4: Topics */}
      <LayerBlock label={layers.topics.label} editable={false}
        chars={0}
        note={`${layers.topics.count} 个活跃话题（LayeredStrategy 按相关性动态加载，不在 system prompt 中直接显示）`}>
        {layers.topics.count === 0
          ? <span style={{ fontSize: 9, color: 'var(--gc-text-dim)', fontStyle: 'italic' }}>（无活跃话题）</span>
          : layers.topics.items.map(t => (
              <div key={t.id} style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 9, color: 'var(--gc-accent2)' }}>{t.title}</div>
                <div style={{ fontSize: 8, color: 'var(--gc-text-dim)', lineHeight: 1.4 }}>{t.summary}</div>
              </div>
            ))}
      </LayerBlock>

      {/* Architecture limits */}
      <div style={{ padding: '8px 10px', background: 'var(--gc-error-bg)', border: '1px solid var(--gc-error-border)', fontSize: 8, color: 'var(--gc-text-dim)', lineHeight: 1.8 }}>
        <div style={{ color: 'var(--gc-red)', letterSpacing: '0.1em', marginBottom: 4, textTransform: 'uppercase' }}>✗ 架构限制（当前不支持）</div>
        {architectureLimits.map((l, i) => <div key={i}>· {l}</div>)}
      </div>
    </div>
  )
}

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
  const [promptData, setPromptData] = useState<Awaited<ReturnType<typeof api.getAgentSystemPrompt>> | null>(null)
  const [promptLoading, setPromptLoading] = useState(false)
  const [skills, setSkills] = useState<Array<{ name: string; description: string }>>([])
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
    setPromptData(null)
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
    setPromptData(null)
    try {
      setPromptData(await api.getAgentSystemPrompt(detail.id))
    } catch { /* ignore */ }
    setPromptLoading(false)
  }

  const loadSkills = async () => {
    setSkillsLoading(true)
    setSkills(await api.getSkills())
    setSkillsLoading(false)
  }

  const switchTab = (t: 'config' | 'prompt' | 'skills') => {
    setTab(t)
    if (t === 'prompt' && !promptData) loadPrompt()
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
              {promptLoading && <div style={{ fontSize: 9, color: 'var(--gc-text-dim)' }}>LOADING…</div>}
              {!promptLoading && !promptData && (
                <button onClick={loadPrompt} className="sp-btn sp-btn-cyan" style={{ fontSize: 9, width: '100%' }}>
                  LOAD STRUCTURED PROMPT
                </button>
              )}
              {promptData && <StructuredPrompt data={promptData} />}
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
                        <div style={{ marginTop: 6, fontSize: 8, color: 'var(--gc-text-dim)', letterSpacing: '0.05em' }}>全局启用（per-agent 开关：架构不支持）</div>
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
