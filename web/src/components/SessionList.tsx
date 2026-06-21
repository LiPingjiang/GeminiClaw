import { MessageSquare, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SessionItem {
  id: string
  label: string
}

interface SessionListProps {
  sessions: SessionItem[]
  activeId: string | undefined
  onSelect: (id: string) => void
  onNew: () => void
}

export default function SessionList({ sessions, activeId, onSelect, onNew }: SessionListProps) {
  return (
    <aside className="w-52 shrink-0 flex flex-col bg-gray-900 border-r border-gray-800">
      <div className="p-3 border-b border-gray-800">
        <button
          onClick={onNew}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
        >
          <Plus size={13} />
          New Chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {sessions.length === 0 && (
          <p className="text-xs text-gray-600 text-center mt-4">No sessions yet</p>
        )}
        {sessions.map(s => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-colors',
              activeId === s.id
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200',
            )}
          >
            <MessageSquare size={12} className="shrink-0" />
            <span className="truncate">{s.label}</span>
          </button>
        ))}
      </div>
    </aside>
  )
}
