import { NavLink } from 'react-router-dom'
import { MessageSquare, Clock, Cpu, Play, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'

const NAV = [
  { to: '/', icon: MessageSquare, label: 'Chat' },
  { to: '/sessions', icon: Clock, label: 'Sessions' },
  { to: '/agents', icon: Cpu, label: 'Agents' },
  { to: '/runs', icon: Play, label: 'Runs' },
  { to: '/config', icon: Settings, label: 'Config' },
] as const

export default function Sidebar() {
  return (
    <aside className="w-56 shrink-0 flex flex-col bg-gray-900 border-r border-gray-800">
      <div className="px-5 py-4 border-b border-gray-800">
        <h1 className="text-base font-bold text-white tracking-tight">GeminiClaw</h1>
      </div>
      <nav className="flex-1 p-2 space-y-0.5">
        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100',
              )
            }
          >
            <Icon size={15} />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}
