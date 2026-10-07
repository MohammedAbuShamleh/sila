// Two overlapping circles: shared memory is the intersection
export default function LogoMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={className}>
      <path d="M16 9.07A8 8 0 0 1 16 22.93A8 8 0 0 1 16 9.07Z" className="fill-forest-300" />
      <circle cx="12" cy="16" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="20" cy="16" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}
