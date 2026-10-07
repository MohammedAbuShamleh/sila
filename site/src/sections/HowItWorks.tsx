import DrawLine from '../components/DrawLine'
import Reveal from '../components/Reveal'
import SectionHeading from '../components/SectionHeading'
import SplitLines from '../components/SplitLines'
import { howItWorks } from '../content'
import { sectionIds } from '../lib/sections'
import { typeset } from '../lib/typeset'

const CARD_STAGGER = 120

// Card 1: translucent white on the light gradient. Card 2: solid forest-900.
const cardStyles = [
  {
    align: 'self-start',
    surface: 'border border-white/80 bg-white/60 text-ink shadow-[0_20px_50px_-30px_rgb(8_48_28/0.45)]',
    sep: 'text-forest-500',
    note: 'text-muted',
    dot: 'bg-muted',
  },
  {
    align: 'self-end',
    surface: 'bg-forest-900 text-forest-50 shadow-[0_24px_60px_-28px_rgb(8_48_28/0.7)]',
    sep: 'text-forest-300',
    note: 'text-forest-300',
    dot: 'bg-forest-300',
  },
]

export default function HowItWorks() {
  const titleId = `${sectionIds.howItWorks}-title`
  return (
    <section id={sectionIds.howItWorks} aria-labelledby={titleId} className="how">
      <div className="page-wrap py-24 md:py-32">
        <SectionHeading id={titleId} text={howItWorks.title} className="text-ink" />
        <p className="mt-6 max-w-[40rem] text-lg leading-[1.85] text-muted md:text-xl md:leading-[1.8]">
          {typeset(howItWorks.lead)}
        </p>

        {/* Right card, then left card: the hand-off reads in the same direction as the text */}
        <div className="mt-14 flex flex-col gap-6 md:mt-20">
          {howItWorks.cards.map((card, i) => {
            const s = cardStyles[i]
            return (
              // The card's surface holds its place at all times; only its content rises in
              <article key={card.title} className={`w-full max-w-[620px] rounded-3xl ${s.align} ${s.surface}`}>
                <Reveal delay={i * CARD_STAGGER} className="p-7 md:p-9">
                  <h3 className="font-display text-2xl leading-snug md:text-[1.7rem]">
                    <SplitLines lines={[card.title]} sepClassName={s.sep} />
                  </h3>
                  <blockquote className="mt-4 text-lg leading-[1.8] md:text-xl">{typeset(card.quote)}</blockquote>
                  <p className={`mt-6 flex items-center gap-2.5 text-sm font-medium ${s.note}`}>
                    <span aria-hidden="true" className={`h-2 w-2 rounded-full ${s.dot}`} />
                    {card.note}
                  </p>
                </Reveal>
              </article>
            )
          })}
        </div>

        <div className="mt-16 flex items-center gap-5">
          <DrawLine className="h-[2px] w-16 shrink-0" lineClassName="bg-forest-900" />
          <p className="text-lg font-medium text-ink md:text-xl">{howItWorks.closing}</p>
        </div>
      </div>
    </section>
  )
}
