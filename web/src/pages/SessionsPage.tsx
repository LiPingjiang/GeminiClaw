import { useCallback, useEffect, useState } from 'react'
import { Trash2, RefreshCw } from 'lucide-react'
import { api, type Session } from '@/lib/api'

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setSessions(await api.getSessions())
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleDelete = async (id: string) => {
    await api.deleteSession(id)
    await load()
  }

  return (
    <div className="p-6 h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Sessions</h2>
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
              <th className="px-5 py-3">Session ID</th>
              <th className="px-5 py-3">Title</th>
              <th className="px-5 py-3">Messages</th>
              <th className="px-5 py-3">Updated</th>
              <th className="px-5 py-3 w-12"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {loading && (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-gray-500">Loading…</td>
              </tr>
            )}
            {!loading && sessions.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-gray-500">No sessions yet</td>
              </tr>
            )}
            {sessions.map(s => (
              <tr key={s.id} className="hover:bg-gray-800/40 transition-colors">
                <td className="px-5 py-3 font-mono text-xs text-gray-400">{s.id.slice(0, 8)}…</td>
                <td className="px-5 py-3 text-gray-300">{s.title ?? '(untitled)'}</td>
                <td className="px-5 py-3 text-gray-400">{s.message_count ?? '—'}</td>
                <td className="px-5 py-3 text-gray-500 text-xs">
                  {new Date(s.updated_at).toLocaleString()}
                </td>
                <td className="px-5 py-3">
                  <button
                    onClick={() => handleDelete(s.id)}
                    className="text-gray-600 hover:text-red-400 transition-colors"
                    title="Delete session"
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
