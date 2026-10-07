import { useEffect, useRef, useState } from 'react'

// One IntersectionObserver shared by the whole page, not one per element.
//
// Motion here only ever adds: every element renders in its final, readable state, and an
// entrance may play only once the observer has *proven* the element was off-screen and then
// scrolled in. If the observer never reports (unsupported, blocked, throttled), nothing is
// hidden and nothing is left half-way.
//   idle    — no report yet (or no IntersectionObserver): static final state
//   present — already on screen when first observed: static, no entrance
//   entered — observed off-screen, then scrolled into view: entrance may play
export type InViewState = 'idle' | 'present' | 'entered'

const handlers = new Map<Element, (visible: boolean) => void>()
let observer: IntersectionObserver | null = null

function getObserver() {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) handlers.get(entry.target)?.(entry.isIntersecting)
    },
    // Fire a little before the element reaches the fold, so an entrance's first frame
    // (content lifted and transparent) is never the frame the reader sees
    { rootMargin: '0px 0px 48px 0px' },
  )
  return observer
}

function release(el: Element) {
  handlers.delete(el)
  observer?.unobserve(el)
}

export function useInView<T extends Element>() {
  const ref = useRef<T>(null)
  const [state, setState] = useState<InViewState>('idle')

  useEffect(() => {
    const el = ref.current
    if (!el || !('IntersectionObserver' in window)) return
    let seenOffscreen = false
    handlers.set(el, (visible) => {
      if (!visible) {
        seenOffscreen = true
        return
      }
      setState(seenOffscreen ? 'entered' : 'present')
      release(el)
    })
    getObserver().observe(el)
    return () => release(el)
  }, [])

  return [ref, state] as const
}
