import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>Dashboard loading…</div>
  </StrictMode>,
)
