// The `//` list marker, drawn rather than typed: it is decoration, so it stays out of
// the text layer (screen readers, contrast checks) while matching the heading separators.
export default function SlashMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 16" aria-hidden="true" focusable="false" className={className}>
      <path d="M7 1 3 15M15 1l-4 14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  )
}
