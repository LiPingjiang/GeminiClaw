import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api, type Run } from '@/lib/api'
import { cn } from '@/lib/utils'

export default function RunsPage() {
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    setRuns(await api.getRuns())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  return (
    <div className="p-6 h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Runs</h2>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-800/60 text-gray-400 text-left text-xs uppercase tracking-wider">
            <tr>
              <th className="px-5 py-3">Run ID</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3">Duration</th>
              <th className="px-5 py-3">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {loading && (
              <tr>
                <td colSpan={4} className="px-5 py-10 text-center text-gray-500">Loading…</td>
              </tr>
            )}
            {!loading && runs.length === 0 && (
              <tr>
                <td colSpan={4} className="px-5 py-10 text-center text-gray-500">No runs yet</td>
              </tr>
            )}
            {runs.map(r => (
              <tr key={r.id} className="hover:bg-gray-800/40 transition-colors">
                <td className="px-5 py-3 font-mono text-xs text-gray-400">{r.id.slice(0, 12)}…</td>
                <td className="px-5 py-3">
                  <span className={cn(
                    'text-xs px-2 py-0.5 rounded-full border',
                    r.status === 'completed' ? 'bg-green-900/60 text-green-300 border-green-800' :
                    r.status === 'running' ? 'bg-yellow-900/60 text-yellow-300 border-yellow-800' :
                    r.status === 'failed' ? 'bg-red-900/60 text-red-300 border-red-800' :
                    'bg-gray-700 text-gray-400 border-gray-600',
                  )}>
                    {r.status}
                  </span>
                </td>
                <td className="px-5 py-3 text-gray-400 text-xs">
                  {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}
                </td>
                <td className="px-5 py-3 text-gray-500 text-xs">
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
