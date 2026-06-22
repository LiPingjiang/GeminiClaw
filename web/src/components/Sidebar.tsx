import { NavLink } from 'react-router-dom'
import { MessageSquare, Clock, Cpu, Play, Settings } from 'lucide-react'
import type { ThemeId } from '@/lib/api'

const NAV = [
  { to: '/', icon: MessageSquare, label: 'Comm', code: 'SYS-01' },
  { to: '/sessions', icon: Clock, label: 'Log', code: 'SYS-02' },
  { to: '/agents', icon: Cpu, label: 'Units', code: 'SYS-03' },
  { to: '/runs', icon: Play, label: 'Ops', code: 'SYS-04' },
  { to: '/config', icon: Settings, label: 'Config', code: 'SYS-05' },
] as const

const THEMES: { id: ThemeId; color: string; label: string }[] = [
  { id: 'space-dark',  color: '#ff8c00', label: 'SPACE' },
  { id: 'day-command', color: '#c05808', label: 'DAY'   },
  { id: 'deep-sea',    color: '#00b8d4', label: 'SEA'   },
]

interface SidebarProps {
  theme: ThemeId
  setTheme: (id: ThemeId) => void
}

export default function Sidebar({ theme, setTheme }: SidebarProps) {
  return (
    <aside
      className="shrink-0 flex flex-col"
      style={{ width: '13rem', background: 'var(--gc-panel)', borderRight: '1px solid var(--gc-border)', position: 'relative' }}
    >
      <div style={{ height: '2px', background: 'linear-gradient(90deg, var(--gc-accent), var(--gc-accent-dim) 70%, transparent)' }} />

      <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid var(--gc-border)', position: 'relative' }}>
        <span style={{ position: 'absolute', top: 8, left: 8, width: 8, height: 8, borderTop: '1px solid var(--gc-accent)', borderLeft: '1px solid var(--gc-accent)' }} />
        <span style={{ position: 'absolute', top: 8, right: 8, width: 8, height: 8, borderTop: '1px solid var(--gc-accent)', borderRight: '1px solid var(--gc-accent)' }} />
        <div style={{ fontSize: 9, letterSpacing: '0.2em', color: 'var(--gc-text-label)', textTransform: 'uppercase', marginBottom: 4 }}>
          BATTLE SYSTEM
        </div>
        <div
          className="flicker"
          style={{ fontSize: 15, letterSpacing: '0.15em', color: 'var(--gc-accent)', fontWeight: 700, fontFamily: "'Orbitron', monospace", textShadow: '0 0 10px var(--gc-accent-glow)' }}
        >
          GEMINICLAW
        </div>
        <div style={{ fontSize: 9, color: 'var(--gc-text-dim)', letterSpacing: '0.1em', marginTop: 2 }}>
          AI-COMMAND / ONLINE
        </div>
        <span style={{ position: 'absolute', bottom: 8, left: 8, width: 8, height: 8, borderBottom: '1px solid var(--gc-accent)', borderLeft: '1px solid var(--gc-accent)' }} />
        <span style={{ position: 'absolute', bottom: 8, right: 8, width: 8, height: 8, borderBottom: '1px solid var(--gc-accent)', borderRight: '1px solid var(--gc-accent)' }} />
      </div>

      <div className="sp-label" style={{ marginTop: 8 }}>◈ SYSTEM COMMANDS</div>

      <nav style={{ flex: 1, padding: '4px 0' }}>
        {NAV.map(({ to, icon: Icon, label, code }) => (
          <NavLink key={to} to={to} end={to === '/'} style={{ textDecoration: 'none', display: 'block' }}>
            {({ isActive }) => (
              <div className={isActive ? 'sp-nav-item active' : 'sp-nav-item'} style={{ justifyContent: 'space-between' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <Icon size={13} />
                  {label}
                </span>
                <span style={{ fontSize: 9, opacity: isActive ? 0.8 : 0.3 }}>{code}</span>
              </div>
            )}
          </NavLink>
        ))}
      </nav>

      <div style={{ borderTop: '1px solid var(--gc-border)', padding: '8px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9, color: 'var(--gc-text-dim)', letterSpacing: '0.1em' }}>
          <span className="blink" style={{ color: 'var(--gc-green)', fontSize: 11 }}>●</span>
          TACTICAL NET ACTIVE
        </div>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          {THEMES.map(t => (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              title={t.label}
              style={{
                width: 12, height: 12,
                borderRadius: '50%',
                background: t.color,
                border: '1px solid transparent',
                outline: theme === t.id ? `2px solid ${t.color}` : 'none',
                outlineOffset: '1px',
                cursor: 'pointer',
                padding: 0,
                transition: 'outline 0.15s',
              }}
            />
          ))}
        </div>
      </div>

      <div style={{ position: 'absolute', right: 0, top: '20%', bottom: '20%', width: 1, background: 'linear-gradient(180deg, transparent, var(--gc-accent) 40%, var(--gc-accent) 60%, transparent)', opacity: 0.15 }} />
    </aside>
  )
}
