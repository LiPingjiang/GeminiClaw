import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { saveTheme, getTheme, autoFillAuthToken } from './lib/api'
import './index.css'
import App from './App'

// Apply saved theme immediately — before React renders — to avoid flash
saveTheme(getTheme())

// Auto-fill auth token from server before mounting (local dev: token auto-configured)
autoFillAuthToken().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
