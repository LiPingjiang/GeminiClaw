import { useEffect, useState } from 'react'
import { Save, CheckCircle, RefreshCw } from 'lucide-react'
import { getConfig, saveConfig, api } from '@/lib/api'

export default function ConfigPage() {
  const [config, setConfig] = useState(getConfig)
  const [saved, setSaved] = useState(false)
  const [tab, setTab] = useState<'auth' | 'identity' | 'memory'>('auth')
  const [agentMd, setAgentMd] = useState('')
  const [memoryMd, setMemoryMd] = useState('')
  const [memLoading, setMemLoading] = useState(false)
  const [memSaved, setMemSaved] = useState(false)

  const handleSave = () => {
    saveConfig(config)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  const loadMemory = async () => {
    setMemLoading(true)
    const d = await api.getGlobalMemory()
    setAgentMd(d.agentMd)
    setMemoryMd(d.memoryMd)
    setMemLoading(false)
  }

  const saveMemory = async () => {
    await api.updateGlobalMemory(agentMd, memoryMd)
    setMemSaved(true)
    setTimeout(() => setMemSaved(false), 2500)
  }

  useEffect(() => {
    if (tab === 'identity' || tab === 'memory') loadMemory()
  }, [tab])

  const TEXTAREA_STYLE: React.CSSProperties = {
    width: '100%', padding: '8px 12px', fontSize: 11, lineHeight: 1.6,
    resize: 'vertical', fontFamily: "'Share Tech Mono', monospace",
    background: 'var(--gc-panel-deep)', border: '1px solid var(--gc-border)',
    color: 'var(--gc-assistant-text)', minHeight: 300,
  }

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto', background: 'var(--gc-bg)' }}>
      <div style={{ fontSize: 9, letterSpacing: '0.2em', color: 'var(--gc-text-label)', textTransform: 'uppercase', marginBottom: 16 }}>
        ◈ SYSTEM CONFIG
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--gc-border)', marginBottom: 20 }}>
        {([
          ['auth', 'AUTH'],
          ['identity', 'AGENT.MD'],
          ['memory', 'GLOBAL MEMORY'],
        ] as const).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            style={{ background: 'none', border: 'none', borderBottom: `2px solid ${tab === t ? 'var(--gc-accent)' : 'transparent'}`, cursor: 'pointer', color: tab === t ? 'var(--gc-accent)' : 'var(--gc-text-dim)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '6px 14px' }}>
            {label}
          </button>
        ))}
      </div>

      {/* Auth tab */}
      {tab === 'auth' && (
        <div style={{ maxWidth: 480 }}>
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: 9, letterSpacing: '0.15em', color: 'var(--gc-text-dim)', textTransform: 'uppercase', marginBottom: 8 }}>
              Auth Token
            </label>
            <input type="password" value={config.authToken}
              onChange={e => setConfig(c => ({ ...c, authToken: e.target.value }))}
              placeholder="optional" className="sp-input"
              style={{ width: '100%', padding: '8px 12px' }} />
            <p style={{ marginTop: 6, fontSize: 9, color: 'var(--gc-text-dim)', letterSpacing: '0.08em' }}>
              Sent as Authorization: Bearer &lt;token&gt;
            </p>
          </div>
          <button onClick={handleSave} className="sp-btn" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {saved ? <CheckCircle size={12} /> : <Save size={12} />}
            {saved ? 'SAVED' : 'SAVE CHANGES'}
          </button>
        </div>
      )}

      {/* AGENT.md tab */}
      {tab === 'identity' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 9, color: 'var(--gc-text-dim)', letterSpacing: '0.08em' }}>
              ~/.gemeniclaw/AGENT.md — agent 身份与领域知识（由代码常量补充行为规则）
            </div>
            <button onClick={loadMemory} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gc-text-dim)', padding: 0 }}>
              <RefreshCw size={11} style={{ animation: memLoading ? 'spin 1s linear infinite' : 'none' }} />
            </button>
          </div>
          <textarea className="sp-input" value={agentMd} onChange={e => setAgentMd(e.target.value)}
            style={TEXTAREA_STYLE} disabled={memLoading} />
          <div style={{ marginTop: 10 }}>
            <button onClick={saveMemory} className="sp-btn" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {memSaved ? <CheckCircle size={12} /> : <Save size={12} />}
              {memSaved ? 'SAVED' : 'SAVE AGENT.MD'}
            </button>
          </div>
        </div>
      )}

      {/* Global memory tab */}
      {tab === 'memory' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 9, color: 'var(--gc-text-dim)', letterSpacing: '0.08em' }}>
              ~/.gemeniclaw/memory/global/MEMORY.md — 全局长期记忆（所有 session 共享）
            </div>
            <button onClick={loadMemory} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gc-text-dim)', padding: 0 }}>
              <RefreshCw size={11} style={{ animation: memLoading ? 'spin 1s linear infinite' : 'none' }} />
            </button>
          </div>
          <textarea className="sp-input" value={memoryMd} onChange={e => setMemoryMd(e.target.value)}
            style={TEXTAREA_STYLE} disabled={memLoading} />
          <div style={{ marginTop: 10 }}>
            <button onClick={saveMemory} className="sp-btn" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {memSaved ? <CheckCircle size={12} /> : <Save size={12} />}
              {memSaved ? 'SAVED' : 'SAVE MEMORY.MD'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
