import { useEffect, useState } from 'react'
import { Cpu, RefreshCw } from 'lucide-react'
import { api, type Agent } from '@/lib/api'
import { cn } from '@/lib/utils'

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    setAgents(await api.getAgents())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  return (
    <div className="p-6 h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Agents</h2>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {loading && <p className="text-gray-500">Loading…</p>}

      {!loading && agents.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-gray-600">
          <Cpu size={32} className="mb-3 opacity-30" />
          <p className="text-sm">No agents running</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map(a => (
          <div key={a.id} className="bg-gray-800/60 border border-gray-700 rounded-xl p-4 hover:border-gray-600 transition-colors">
            <div className="flex items-center gap-3 mb-2">
              <Cpu size={18} className="text-blue-400 shrink-0" />
              <span className="font-medium text-sm truncate flex-1">{a.name}</span>
              <span className={cn(
                'text-xs px-2 py-0.5 rounded-full shrink-0',
                a.status === 'active' ? 'bg-green-900/60 text-green-300 border border-green-800' :
                a.status === 'idle' ? 'bg-gray-700 text-gray-400' :
                'bg-gray-700 text-gray-400',
              )}>
                {a.status}
              </span>
            </div>
            {a.lastActive && (
              <p className="text-xs text-gray-500 pl-7">
                Last active: {new Date(a.lastActive).toLocaleString()}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
