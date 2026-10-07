import { useEffect, useRef } from 'react'
import { toArabicDigits } from '../lib/digits'
import { prefersReducedMotion } from '../lib/motion'

const DURATION = 1400
const easeOut = (p: number) => 1 - (1 - p) ** 3

// Shows the real value at rest. Only when `play` turns true (the figure has just scrolled in)
// does it drop to zero and climb back; if that never happens, the true number stays.
export default function CountUp({ value, play }: { value: number; play: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  const final = toArabicDigits(value)

  useEffect(() => {
    const el = ref.current
    if (!el || !play || prefersReducedMotion()) return
    let frame = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / DURATION)
      el.textContent = toArabicDigits(Math.round(value * easeOut(p)))
      if (p < 1) frame = requestAnimationFrame(tick)
    }
    el.textContent = toArabicDigits(0)
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      el.textContent = final
    }
  }, [play, value, final])

  return (
    // The invisible copy reserves the final width, so climbing digits never shift anything
    <span className="grid">
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
        {final}
      </span>
      <span ref={ref} aria-hidden="true" className="col-start-1 row-start-1">
        {final}
      </span>
      <span className="sr-only">{final}</span>
    </span>
  )
}
