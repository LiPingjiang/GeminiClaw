import { useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import ChatPage from './pages/ChatPage'
import SessionsPage from './pages/SessionsPage'
import AgentsPage from './pages/AgentsPage'
import RunsPage from './pages/RunsPage'
import ConfigPage from './pages/ConfigPage'
import { getTheme, saveTheme, type ThemeId } from './lib/api'

export default function App() {
  const [theme, setTheme] = useState<ThemeId>(getTheme)

  const handleThemeChange = (id: ThemeId) => {
    saveTheme(id)
    setTheme(id)
  }

  return (
    <BrowserRouter>
      <div className="flex overflow-hidden" style={{ height: '100vh' }}>
        <Sidebar theme={theme} setTheme={handleThemeChange} />
        <main className="flex-1 overflow-hidden" style={{ position: 'relative' }}>
          <Routes>
            <Route path="/" element={<ChatPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/runs" element={<RunsPage />} />
            <Route path="/config" element={<ConfigPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
