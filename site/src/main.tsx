import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import App from './App'
import './index.css'

const root = document.getElementById('root')!
const app = (
  <StrictMode>
    <App />
  </StrictMode>
)

// Production HTML is prerendered (scripts/prerender.mjs): attach to it. The dev server ships an empty root.
if (root.firstElementChild) hydrateRoot(root, app)
else createRoot(root).render(app)
