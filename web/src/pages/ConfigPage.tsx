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
    <div className="p-6 h-full overflow-y-auto">
      <h2 className="text-xl font-semibold mb-6">Config</h2>

      <div className="max-w-lg space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1.5">
            Auth Token
          </label>
          <input
            type="password"
            value={config.authToken}
            onChange={e => setConfig(c => ({ ...c, authToken: e.target.value }))}
            placeholder="optional"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3.5 py-2.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
          />
          <p className="mt-1 text-xs text-gray-500">Sent as Authorization: Bearer &lt;token&gt;</p>
        </div>

        <button
          onClick={handleSave}
          className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
        >
          {saved ? <CheckCircle size={14} /> : <Save size={14} />}
          {saved ? 'Saved!' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}
