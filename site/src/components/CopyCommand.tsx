import { useEffect, useRef, useState } from 'react'
import { install } from '../content'

function legacyCopy(text: string) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  return ok
}

// The async API can be refused (permissions, iframes, unfocused window), not just missing
async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return legacyCopy(text)
  }
}

export default function CopyCommand() {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number>(undefined)
  const commandRef = useRef<HTMLSpanElement>(null)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function copy() {
    if (!(await writeClipboard(install.command))) {
      // Last resort: select the command so it can be copied by hand
      if (commandRef.current) window.getSelection()?.selectAllChildren(commandRef.current)
      return
    }
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex shrink-0 items-center gap-2.5 rounded-full bg-white py-1.5 pe-1.5 ps-4 shadow-[0_10px_30px_-10px_rgb(8_48_28/0.45)] [--focus:theme(colors.forest.700)] sm:gap-3 sm:ps-5">
      <code dir="ltr" className="whitespace-nowrap font-mono text-sm font-medium text-forest-700 sm:text-[15px]">
        <span aria-hidden="true" className="hidden select-none text-muted sm:inline">
          ${' '}
        </span>
        <span ref={commandRef}>{install.command}</span>
      </code>

      {/* Below sm the note and its rule give way, as the prompt does: the capsule never wraps, and
          with the full npm command it would push the copy button off a 360px screen. The
          guarantees section says the same thing in full. */}
      <span aria-hidden="true" className="hidden h-4 w-px shrink-0 bg-rule sm:block" />
      <span className="hidden whitespace-nowrap text-[13px] font-medium text-muted sm:block sm:text-sm">{install.note}</span>

      {/* Both states share one grid cell so the button never changes width */}
      <button
        type="button"
        onClick={copy}
        className="grid shrink-0 rounded-full bg-forest-900 px-3.5 py-2 text-sm font-bold text-white hover:bg-forest-700 motion-safe:transition-colors sm:px-4"
      >
        <span className={`col-start-1 row-start-1 flex items-center justify-center gap-1.5 ${copied ? 'invisible' : ''}`}>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="h-3.5 w-3.5">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 3.5v-.25A1.75 1.75 0 0 0 8.75 1.5h-5.5A1.75 1.75 0 0 0 1.5 3.25v5.5a1.75 1.75 0 0 0 1.75 1.75h.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          {install.copy}
        </span>
        <span className={`col-start-1 row-start-1 text-center ${copied ? '' : 'invisible'}`}>{install.copied}</span>
      </button>

      <span role="status" className="sr-only">
        {copied ? install.copiedAnnouncement : ''}
      </span>
    </div>
  )
}
