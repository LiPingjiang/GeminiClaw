import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import ChatPage from './pages/ChatPage'
import SessionsPage from './pages/SessionsPage'
import AgentsPage from './pages/AgentsPage'

const Placeholder = ({ name }: { name: string }) => (
  <div className="p-8 text-gray-400">{name} page coming soon…</div>
)

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex h-screen bg-gray-950 text-gray-100 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<ChatPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/runs" element={<Placeholder name="Runs" />} />
            <Route path="/config" element={<Placeholder name="Config" />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
