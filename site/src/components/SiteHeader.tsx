import { useEffect, useState } from 'react'
import { brand, nav } from '../content'
import LogoMark from './LogoMark'

// Past this many pixels the header leaves its resting state over the hero
const SCROLL_THRESHOLD = 8

// True once the page is scrolled. A passive listener with one read per frame — not an
// IntersectionObserver, so the page keeps a single shared observer (useInView).
function useScrolled() {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    let frame = 0
    const update = () => {
      frame = 0
      setScrolled(window.scrollY > SCROLL_THRESHOLD)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update() // a reload mid-page starts scrolled
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [])
  return scrolled
}

// Fixed header: transparent and 80px over the hero; once scrolled, a translucent dark bar with a
// soft shadow that shrinks to 56px (see .site-header).
export default function SiteHeader() {
  const scrolled = useScrolled()
  return (
    <header data-scrolled={scrolled} className="site-header [--focus:theme(colors.forest.100)]">
      <div className="page-wrap flex h-full items-center justify-between">
        <div className="relative">
          <a href="#main" className="flex items-center gap-2.5 text-white">
            <LogoMark className="h-8 w-8" />
            <span className="font-display text-[1.7rem] font-bold leading-none">{brand.name}</span>
          </a>
          {/* Hangs below the logo, outside the bar's height; hidden once the bar shrinks */}
          <p className="site-tagline absolute start-0 top-full mt-2.5 whitespace-nowrap text-xs font-medium leading-[1.5] text-forest-100">
            {brand.tagline.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </p>
        </div>

        <nav aria-label={nav.label}>
          <ul className="flex items-center gap-6 lg:gap-8">
            {nav.links.map((link) => (
              // Section links need the width; below `sm` only GitHub stays
              <li key={link.label} className={link.showOnMobile ? '' : 'hidden sm:block'}>
                <a href={link.href} className="link-draw text-[15px] font-medium text-forest-50">
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  )
}
