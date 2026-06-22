import { useState } from 'react'
import { Save, CheckCircle } from 'lucide-react'
import { getConfig, saveConfig } from '@/lib/api'

export default function ConfigPage() {
  const [config, setConfig] = useState(getConfig)
  const [saved, setSaved] = useState(false)

  const handleSave = () => {
    saveConfig(config)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto', background: 'var(--gc-bg)' }}>
      <div style={{ fontSize: 9, letterSpacing: '0.2em', color: 'var(--gc-text-label)', textTransform: 'uppercase', marginBottom: 20 }}>
        ◈ SYSTEM CONFIG
      </div>

      <div style={{ maxWidth: 480 }}>
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontSize: 9, letterSpacing: '0.15em', color: 'var(--gc-text-dim)', textTransform: 'uppercase', marginBottom: 8 }}>
            Auth Token
          </label>
          <input
            type="password"
            value={config.authToken}
            onChange={e => setConfig(c => ({ ...c, authToken: e.target.value }))}
            placeholder="optional"
            className="sp-input"
            style={{ width: '100%', padding: '8px 12px' }}
          />
          <p style={{ marginTop: 6, fontSize: 9, color: 'var(--gc-text-dim)', letterSpacing: '0.08em' }}>
            Sent as Authorization: Bearer &lt;token&gt;
          </p>
        </div>

        <button onClick={handleSave} className="sp-btn" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {saved ? <CheckCircle size={12} /> : <Save size={12} />}
          {saved ? 'SAVED' : 'SAVE CHANGES'}
        </button>
      </div>
    </div>
  )
}
