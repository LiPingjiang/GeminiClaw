import { useEffect, useState } from 'react'
import { Cpu, RefreshCw, Copy, Archive, X, ExternalLink, ChevronDown, ChevronRight, Lock, Edit3 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type Agent } from '@/lib/api'

// ── MarkdownField: preview by default, click to edit ─────────────────────────
function MarkdownField({ value, onChange, label, note, placeholder = '(empty — click to edit)', minHeight = 120 }: {
  value: string
  onChange: (v: string) => void
  label?: string
  note?: string
  placeholder?: string
  minHeight?: number
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [hovered, setHovered] = useState(false)

  const startEdit = () => { setDraft(value); setEditing(true) }
  const commit = () => { onChange(draft); setEditing(false) }
  const cancel = () => setEditing(false)

  return (
    <div style={{ marginBottom: 14 }}>
      {label && (
        <div style={{ fontSize: 8, letterSpacing: '0.15em', color: 'var(--gc-text-label)', textTransform: 'uppercase', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
          {label}
          {note && <span style={{ color: 'var(--gc-text-dim)', fontSize: 8, fontWeight: 'normal', textTransform: 'none', letterSpacing: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note}</span>}
          {!editing && (
            <Edit3 size={9} style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--gc-text-dim)', cursor: 'pointer' }} onClick={startEdit} />
          )}
        </div>
      )}
      {editing ? (
        <div>
          <textarea className="sp-input" value={draft} onChange={e => setDraft(e.target.value)}
            autoFocus
            style={{ width: '100%', padding: '6px 8px', fontSize: 11, lineHeight: 1.6, resize: 'vertical', fontFamily: "'Share Tech Mono', monospace", minHeight, boxSizing: 'border-box' }}
            onKeyDown={e => { if (e.key === 'Escape') cancel() }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button onClick={commit} className="sp-btn sp-btn-cyan" style={{ flex: 1, fontSize: 9, padding: '3px 8px' }}>SAVE</button>
            <button onClick={cancel} className="sp-btn" style={{ flex: 1, fontSize: 9, padding: '3px 8px' }}>CANCEL</button>
          </div>
        </div>
      ) : (
        <div
          onClick={startEdit}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{
            cursor: 'text',
            padding: '8px 10px',
            minHeight,
            background: 'var(--gc-panel-deep)',
            border: `1px solid ${hovered ? 'var(--gc-border-hi)' : 'var(--gc-border)'}`,
            transition: 'border-color 0.15s',
            position: 'relative',
          }}
        >
          {hovered && !value && (
            <Edit3 size={10} style={{ position: 'absolute', top: 7, right: 8, color: 'var(--gc-text-dim)', opacity: 0.4, pointerEvents: 'none' }} />
          )}
          {value ? (
            <div className="prose-space" style={{ fontSize: 11 }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
            </div>
          ) : (
            <span style={{ fontSize: 9, color: 'var(--gc-text-dim)', fontStyle: 'italic' }}>{placeholder}</span>
          )}
        </div>
      )}
    </div>
  )
}

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
  const { layers, model, modelFamily, totalChars } = data
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
  const [tab, setTab] = useState<'config' | 'prompt' | 'skills' | 'memory'>('config')
  const [agentConfig, setAgentConfig] = useState<{ skills: string[] | null; constants: Record<string, string | null>; model: string | null }>({ skills: null, constants: {}, model: null })
  const [configDirty, setConfigDirty] = useState(false)
  const [configSaving, setConfigSaving] = useState(false)
  const [promptData, setPromptData] = useState<Awaited<ReturnType<typeof api.getAgentSystemPrompt>> | null>(null)
  const [promptLoading, setPromptLoading] = useState(false)
  const [skills, setSkills] = useState<Array<{ name: string; description: string }>>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [agentMdMem, setAgentMdMem] = useState('')
  const [memoryMdMem, setMemoryMdMem] = useState('')
  const [memLoading, setMemLoading] = useState(false)
  const [memDirty, setMemDirty] = useState(false)
  const [memSaving, setMemSaving] = useState(false)

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
    setAgentMdMem('')
    setMemoryMdMem('')
    setMemDirty(false)
    setDetailLoading(true)
    if (skills.length === 0) loadSkills() // pre-load for config tab skill checkboxes
    loadModels() // pre-load for model dropdown
    try {
      const d = await api.getAgent(id)
      setDetail(d)
      setEditName(d.name)
      setEditDesc(d.description ?? '')
      // Load per-agent config
      const cfg = await api.getAgentConfig(d.id)
      setAgentConfig(cfg.config)
      setConfigDirty(false)
    } catch {
      setDetail(null)
    }
    setDetailLoading(false)
  }

  const saveAgentConfig = async () => {
    if (!detail) return
    setConfigSaving(true)
    await api.updateAgentConfig(detail.id, agentConfig)
    setConfigDirty(false)
    setConfigSaving(false)
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

  const loadModels = async () => {
    if (models.length > 0) return
    setModels(await api.getModels())
  }

  const loadMemory = async () => {
    const sid = detail?.session_id
    if (!sid) return
    setMemLoading(true)
    try {
      const d = await api.getSessionMemory(sid)
      setAgentMdMem(d.agentMd)
      setMemoryMdMem(d.memoryMd)
      setMemDirty(false)
    } catch { /* ignore */ }
    setMemLoading(false)
  }

  const saveMemory = async () => {
    const sid = detail?.session_id
    if (!sid) return
    setMemSaving(true)
    await api.updateSessionMemory(sid, agentMdMem, memoryMdMem)
    setMemDirty(false)
    setMemSaving(false)
  }

  const createAgent = async () => {
    const name = window.prompt('Agent 名称（留空使用默认名）', '')
    if (name === null) return // cancelled
    setCreating(true)
    try {
      const { sessionId } = await api.createSession()
      await api.createSessionAgent(sessionId, 'base', name.trim() || undefined)
      await load()
    } catch { /* ignore */ }
    setCreating(false)
  }

  const switchTab = (t: 'config' | 'prompt' | 'skills' | 'memory') => {
    setTab(t)
    if (t === 'prompt' && !promptData) loadPrompt()
    if (t === 'skills' && skills.length === 0) loadSkills()
    if (t === 'config') loadModels()
    if (t === 'memory') loadMemory()
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
      {/* ── Agent list (only when no agent selected) ── */}
      {!selectedId && <div style={{ flex: 1, padding: 24, overflowY: 'auto', background: 'var(--gc-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontSize: 9, letterSpacing: '0.2em', color: 'var(--gc-text-label)', textTransform: 'uppercase' }}>◈ UNIT REGISTRY</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={createAgent} disabled={creating} className="sp-btn sp-btn-cyan" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              + NEW AGENT
            </button>
            <button onClick={load} disabled={loading} className="sp-btn" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <RefreshCw size={10} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
              REFRESH
            </button>
          </div>
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
      </div>}

      {/* ── Detail panel (full area) ── */}
      {selectedId && (
        <div style={{ flex: 1, background: 'var(--gc-panel)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--gc-border)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={() => { setSelectedId(null); setDetail(null) }}
              style={{ background: 'none', border: '1px solid var(--gc-border)', cursor: 'pointer', color: 'var(--gc-text-dim)', padding: '3px 10px', fontSize: 9, letterSpacing: '0.1em', display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
              <X size={10} />
              BACK
            </button>
            <div style={{ display: 'flex', gap: 0 }}>
              {(['config', 'memory', 'prompt', 'skills'] as const).map(t => (
                <button key={t} onClick={() => switchTab(t)}
                  style={{ background: 'none', border: 'none', borderBottom: `2px solid ${tab === t ? 'var(--gc-accent)' : 'transparent'}`, cursor: 'pointer', color: tab === t ? 'var(--gc-accent)' : 'var(--gc-text-dim)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '4px 10px' }}>
                  {t === 'config' ? 'CONFIG' : t === 'memory' ? 'MEMORY' : t === 'prompt' ? 'PROMPT' : 'SKILLS'}
                </button>
              ))}
            </div>
            {detail && !detailLoading && (
              <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--gc-accent2)', fontFamily: "'Share Tech Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {detail.name}
              </span>
            )}
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
                  : skills.map(sk => {
                      const inheritAll = agentConfig.skills === null
                      const enabled = inheritAll || agentConfig.skills!.includes(sk.name)
                      return (
                        <div key={sk.name} style={{ marginBottom: 10, padding: 10, background: 'var(--gc-panel-deep)', border: `1px solid ${enabled ? 'var(--gc-border)' : 'var(--gc-border-dim)'}`, opacity: enabled ? 1 : 0.5 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                            <span style={{ fontSize: 9, color: enabled ? 'var(--gc-green)' : 'var(--gc-red)' }}>{enabled ? '✓' : '✗'}</span>
                            <span style={{ fontSize: 10, color: 'var(--gc-accent2)' }}>{sk.name}</span>
                            <span style={{ marginLeft: 'auto', fontSize: 8, color: 'var(--gc-text-dim)' }}>
                              {inheritAll ? '继承全局' : enabled ? '此 agent 已启用' : '此 agent 已禁用'}
                            </span>
                          </div>
                          <div style={{ fontSize: 9, color: 'var(--gc-text-dim)', lineHeight: 1.5 }}>{sk.description}</div>
                        </div>
                      )
                    })
              }
              <div style={{ marginTop: 12, fontSize: 8, color: 'var(--gc-text-dim)', lineHeight: 1.6 }}>
                技能开关在 Config 标签页中按 agent 单独配置。
              </div>
            </div>
          )}

          {detail && !detailLoading && tab === 'memory' && (
            <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
              {memLoading ? (
                <div style={{ fontSize: 9, color: 'var(--gc-text-dim)', letterSpacing: '0.1em' }}>LOADING…</div>
              ) : !detail.session_id ? (
                <div style={{ fontSize: 9, color: 'var(--gc-text-dim)' }}>此 agent 无关联 session，无法读取 memory 文件</div>
              ) : (
                <>
                  <MarkdownField
                    label="AGENT.MD"
                    note={`agents/${detail.id}/AGENT.MD`}
                    value={agentMdMem}
                    onChange={v => { setAgentMdMem(v); setMemDirty(true) }}
                    minHeight={160}
                    placeholder="(empty — agent-specific identity, edited here)"
                  />
                  <MarkdownField
                    label="MEMORY.MD"
                    note={`agents/${detail.id}/MEMORY.MD`}
                    value={memoryMdMem}
                    onChange={v => { setMemoryMdMem(v); setMemDirty(true) }}
                    minHeight={200}
                    placeholder="(empty — agent long-term memory, written by triage)"
                  />
                  <button onClick={saveMemory} disabled={!memDirty || memSaving} className="sp-btn sp-btn-cyan" style={{ width: '100%', fontSize: 10 }}>
                    {memSaving ? 'SAVING…' : memDirty ? 'SAVE MEMORY FILES ✱' : 'MEMORY SAVED'}
                  </button>
                </>
              )}
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

              <button onClick={saveDetail} disabled={saving} className="sp-btn" style={{ width: '100%', marginBottom: 12 }}>
                {saving ? 'SAVING…' : 'SAVE NAME/DESC'}
              </button>

              {/* Per-agent config */}
              <div style={{ borderTop: '1px solid var(--gc-border)', paddingTop: 12, marginBottom: 12 }}>
                <div style={{ fontSize: 8, letterSpacing: '0.12em', color: 'var(--gc-text-label)', textTransform: 'uppercase', marginBottom: 8 }}>Per-Agent 配置</div>

                {/* Model override */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 8, color: 'var(--gc-text-dim)', marginBottom: 4 }}>路由模型</div>
                  <select className="sp-input" value={agentConfig.model ?? ''}
                    onChange={e => { setAgentConfig(c => ({ ...c, model: e.target.value || null })); setConfigDirty(true) }}
                    style={{ width: '100%', padding: '4px 8px', fontSize: 10 }}>
                    <option value="">（继承全局 routing.default）</option>
                    {models.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>

                {/* Skills whitelist */}
                {skills.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 8, color: 'var(--gc-text-dim)', marginBottom: 4 }}>
                      技能（不勾选=禁用；全部不勾=不加载任何技能；留空复选框=继承全局所有技能）
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                      <input type="checkbox"
                        checked={agentConfig.skills === null}
                        onChange={e => { setAgentConfig(c => ({ ...c, skills: e.target.checked ? null : [] })); setConfigDirty(true) }}
                        id="skills-inherit" />
                      <label htmlFor="skills-inherit" style={{ fontSize: 9, color: 'var(--gc-accent2)', cursor: 'pointer' }}>
                        继承全局（加载所有技能）
                      </label>
                    </div>
                    {agentConfig.skills !== null && skills.map(sk => (
                      <div key={sk.name} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                        <input type="checkbox"
                          checked={(agentConfig.skills ?? []).includes(sk.name)}
                          onChange={e => {
                            const current = agentConfig.skills ?? []
                            const next = e.target.checked ? [...current, sk.name] : current.filter(s => s !== sk.name)
                            setAgentConfig(c => ({ ...c, skills: next }))
                            setConfigDirty(true)
                          }}
                          id={`skill-${sk.name}`} />
                        <label htmlFor={`skill-${sk.name}`} style={{ fontSize: 9, color: 'var(--gc-text)', cursor: 'pointer' }}>
                          {sk.name}
                          <span style={{ marginLeft: 6, color: 'var(--gc-text-dim)', fontSize: 8 }}>{sk.description.slice(0, 30)}</span>
                        </label>
                      </div>
                    ))}
                  </div>
                )}

                <button onClick={saveAgentConfig} disabled={!configDirty || configSaving} className="sp-btn sp-btn-cyan" style={{ width: '100%', fontSize: 10 }}>
                  {configSaving ? 'SAVING…' : configDirty ? 'SAVE AGENT CONFIG ✱' : 'AGENT CONFIG SAVED'}
                </button>
              </div>

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
