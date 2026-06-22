import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { saveTheme, getTheme } from './lib/api'
import './index.css'
import App from './App'

// Apply saved theme immediately — before React renders — to avoid flash
saveTheme(getTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
