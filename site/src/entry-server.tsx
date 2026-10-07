import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import App from './App'

// Build-time render: the page ships as finished HTML and paints before any JS runs.
export function render() {
  return renderToString(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
