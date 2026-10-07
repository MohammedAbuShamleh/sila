import type { CSSProperties, ElementType, ReactNode } from 'react'
import { useInView } from '../hooks/useInView'

type Props = {
  as?: ElementType
  delay?: number
  className?: string
  children: ReactNode
}

// Rises into place when scrolled into view (see .reveal in index.css). Its resting state is its
// final state: the entrance is an animation that starts on entry, never a hidden state that waits.
export default function Reveal({ as: Tag = 'div', delay = 0, className = '', children }: Props) {
  const [ref, state] = useInView<HTMLElement>()
  return (
    <Tag
      ref={ref}
      data-motion={state === 'entered' ? 'enter' : undefined}
      className={`reveal ${className}`}
      style={{ '--delay': `${delay}ms` } as CSSProperties}
    >
      {children}
    </Tag>
  )
}
