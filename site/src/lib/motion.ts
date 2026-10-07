// For JS-driven motion (parallax, counters). CSS motion is guarded by the same query in index.css.
export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
