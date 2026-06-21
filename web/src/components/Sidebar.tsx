import { NavLink } from 'react-router-dom'
import { MessageSquare, Clock, Cpu, Play, Settings } from 'lucide-react'

const NAV = [
  { to: '/', icon: MessageSquare, label: 'Comm', code: 'SYS-01' },
  { to: '/sessions', icon: Clock, label: 'Log', code: 'SYS-02' },
  { to: '/agents', icon: Cpu, label: 'Units', code: 'SYS-03' },
  { to: '/runs', icon: Play, label: 'Ops', code: 'SYS-04' },
  { to: '/config', icon: Settings, label: 'Config', code: 'SYS-05' },
] as const

export default function Sidebar() {
  return (
    <aside
      className="shrink-0 flex flex-col"
      style={{
        width: '13rem',
        background: '#060d1a',
        borderRight: '1px solid #0d2a40',
        position: 'relative',
      }}
    >
      {/* Top amber divider line */}
      <div style={{ height: '2px', background: 'linear-gradient(90deg, #ff8c00, #7a3c00 70%, transparent)' }} />

      {/* Ship designation header */}
      <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid #0d2a40', position: 'relative' }}>
        {/* Corner brackets */}
        <span style={{ position: 'absolute', top: 8, left: 8, width: 8, height: 8,
          borderTop: '1px solid #ff8c00', borderLeft: '1px solid #ff8c00' }} />
        <span style={{ position: 'absolute', top: 8, right: 8, width: 8, height: 8,
          borderTop: '1px solid #ff8c00', borderRight: '1px solid #ff8c00' }} />

        <div style={{ fontSize: 9, letterSpacing: '0.2em', color: '#7a5c20', textTransform: 'uppercase', marginBottom: 4 }}>
          BATTLE SYSTEM
        </div>
        <div
          className="flicker"
          style={{ fontSize: 15, letterSpacing: '0.15em', color: '#ff8c00', fontWeight: 700,
            fontFamily: "'Orbitron', monospace", textShadow: '0 0 10px rgba(255,140,0,0.8)' }}
        >
          GEMINICLAW
        </div>
        <div style={{ fontSize: 9, color: '#3d5060', letterSpacing: '0.1em', marginTop: 2 }}>
          AI-COMMAND / ONLINE
        </div>

        {/* Bottom brackets */}
        <span style={{ position: 'absolute', bottom: 8, left: 8, width: 8, height: 8,
          borderBottom: '1px solid #ff8c00', borderLeft: '1px solid #ff8c00' }} />
        <span style={{ position: 'absolute', bottom: 8, right: 8, width: 8, height: 8,
          borderBottom: '1px solid #ff8c00', borderRight: '1px solid #ff8c00' }} />
      </div>

      {/* Nav section label */}
      <div className="sp-label" style={{ marginTop: 8 }}>
        ◈ SYSTEM COMMANDS
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, padding: '4px 0' }}>
        {NAV.map(({ to, icon: Icon, label, code }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            style={{ textDecoration: 'none', display: 'block' }}
          >
            {({ isActive }) => (
              <div
                className={isActive ? 'sp-nav-item active' : 'sp-nav-item'}
                style={{ justifyContent: 'space-between' }}
              >
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

      {/* Bottom status strip */}
      <div style={{ borderTop: '1px solid #0d2a40', padding: '8px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9,
          color: '#3d5060', letterSpacing: '0.1em' }}>
          <span className="blink" style={{ color: '#00cc66', fontSize: 11 }}>●</span>
          TACTICAL NET ACTIVE
        </div>
      </div>

      {/* Right side accent line */}
      <div style={{ position: 'absolute', right: 0, top: '20%', bottom: '20%', width: 1,
        background: 'linear-gradient(180deg, transparent, #ff8c00 40%, #ff8c00 60%, transparent)',
        opacity: 0.15 }} />
    </aside>
  )
}
