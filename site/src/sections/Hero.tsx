import { useEffect, useRef, type RefObject } from 'react'
import CopyCommand from '../components/CopyCommand'
import SplitLines from '../components/SplitLines'
import { hero } from '../content'
import { prefersReducedMotion } from '../lib/motion'
import { typeset } from '../lib/typeset'

const GLOW_MAX_SHIFT = 12

// -1..1 → ±12px. Clamping matters: while dragging outside the window, coordinates leave the viewport
const shift = (pos: number, size: number) =>
  Math.max(-1, Math.min(1, (pos / size - 0.5) * 2)) * GLOW_MAX_SHIFT

// The glow follows the pointer by at most 12px — transform only, one write per frame.
// Listens on window, not the hero: the header sits on top and would otherwise make the glow jump.
function useGlowParallax(glowRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const glow = glowRef.current
    if (!glow) return
    const finePointer = window.matchMedia('(pointer: fine)')
    let frame = 0
    let x = 0
    let y = 0

    const apply = () => {
      frame = 0
      glow.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply)
    }
    const onMove = (e: PointerEvent) => {
      if (prefersReducedMotion() || !finePointer.matches) return
      x = shift(e.clientX, window.innerWidth)
      y = shift(e.clientY, window.innerHeight)
      schedule()
    }
    const onLeave = () => {
      x = 0
      y = 0
      schedule()
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      cancelAnimationFrame(frame)
    }
  }, [glowRef])
}

export default function Hero() {
  const glowRef = useRef<HTMLDivElement>(null)
  useGlowParallax(glowRef)

  return (
    <section aria-labelledby="hero-title" className="hero relative isolate flex min-h-screen flex-col">
      <div aria-hidden="true" className="hero-stripes" />

      {/* Title, paragraph and command sit together as one block, centred between the header
          (pt) and the white fade at the bottom (pb keeps the block above it). Phones get a
          deeper pb: on tall narrow screens centring pushes the paragraph down the gradient,
          and this keeps it clear of the forest-700 stop with room to spare. */}
      <div className="page-wrap relative flex flex-1 flex-col justify-center pb-48 pt-32 md:pb-40">
        <h1
          id="hero-title"
          className="words-on-load font-display text-[clamp(2.75rem,1.2rem+5.4vw,5.5rem)] leading-[1.15] text-white"
        >
          <SplitLines lines={hero.title} sepClassName="text-forest-300" breakBelowMd words />
        </h1>

        <p className="mt-7 max-w-[36rem] text-[17px] leading-[1.85] text-forest-50 md:text-xl md:leading-[1.8]">
          {typeset(hero.lead)}
        </p>

        <div className="relative mt-10 flex items-center md:mt-12">
          {/* Anchored to this row so it can never drift under the paragraph (see .hero-glow) */}
          <div ref={glowRef} aria-hidden="true" className="hero-glow" />
          {/* RTL: the capsule opens the row on the right, flush with the title and paragraph */}
          <CopyCommand />
          {/* The rule leaves the capsule and runs to the left screen edge, fading as it goes.
              It draws outward from the capsule (origin right) in a pure CSS load animation */}
          <div
            aria-hidden="true"
            className="draw-x draw-on-load me-[calc(50%-50vw)] h-[2px] min-w-8 flex-1 rounded-full bg-[linear-gradient(to_left,rgb(255_255_255/0.95),rgb(255_255_255/0))]"
          />
        </div>
      </div>
    </section>
  )
}
