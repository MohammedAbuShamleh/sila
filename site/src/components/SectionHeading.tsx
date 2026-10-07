import { useInView } from '../hooks/useInView'
import SplitLines from './SplitLines'

type Props = {
  id?: string
  text: string
  className?: string
  sepClassName?: string
  // 'lead' marks the page's most important section title (56px on desktop instead of 52px)
  size?: 'default' | 'lead'
}

const SIZES = {
  default: 'text-[clamp(2rem,1.3rem+2.6vw,3.25rem)]',
  lead: 'text-[clamp(2.25rem,1.4rem+2.9vw,3.5rem)]',
}

// Section title in the house pattern: bold part // light part. Words rise in one by one the
// first time it scrolls into view; at rest (and with reduced motion) it is simply there.
export default function SectionHeading({ id, text, className = '', sepClassName = 'text-forest-500', size = 'default' }: Props) {
  const [ref, state] = useInView<HTMLHeadingElement>()
  return (
    <h2
      ref={ref}
      id={id}
      data-motion={state === 'entered' ? 'enter' : undefined}
      className={`font-display ${SIZES[size]} leading-[1.3] [text-wrap:balance] ${className}`}
    >
      {/* Same rule as the hero: on narrow screens each half gets its own line, instead of
          whatever word happens to spill over */}
      <SplitLines lines={[text]} sepClassName={sepClassName} breakBelowMd words />
    </h2>
  )
}
