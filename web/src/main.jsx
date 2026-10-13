import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// import removed - styles are in App.css
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
