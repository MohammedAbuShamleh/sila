import { useInView } from '../hooks/useInView'

type Props = {
  className?: string // size of the rule (the observed box)
  lineClassName?: string // colour of the drawn stroke
}

// A horizontal rule that draws itself from the right (line start) when scrolled into view.
// It rests fully drawn; the draw is an animation that plays on entry. The wrapper is what's
// observed, since the stroke's first animation frame is a zero-width box.
export default function DrawLine({ className = '', lineClassName = '' }: Props) {
  const [ref, state] = useInView<HTMLSpanElement>()
  return (
    <span ref={ref} aria-hidden="true" className={`block ${className}`}>
      <span
        data-motion={state === 'entered' ? 'enter' : undefined}
        className={`draw-x block h-full w-full ${lineClassName}`}
      />
    </span>
  )
}
