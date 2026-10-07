import Reveal from '../components/Reveal'
import SectionHeading from '../components/SectionHeading'
import { guarantees } from '../content'
import { sectionIds } from '../lib/sections'
import { typeset } from '../lib/typeset'

const CARD_STAGGER = 120

// 01, 02, … — drawn by .ghost-index::before from data-ghost (decoration, not text)
const ghostIndex = (i: number) => String(i + 1).padStart(2, '0')

export default function Guarantees() {
  const titleId = `${sectionIds.guarantees}-title`
  return (
    <section id={sectionIds.guarantees} aria-labelledby={titleId} className="bg-white">
      <div className="page-wrap py-24 md:py-32">
        <SectionHeading id={titleId} text={guarantees.title} size="lead" className="text-ink" />

        {/* 2px dividers: the grid's own background shows through the gaps */}
        <ul className="mt-14 grid gap-[2px] bg-rule md:mt-20 md:grid-cols-2">
          {guarantees.items.map((item, i) => (
            <li key={item.title} data-ghost={ghostIndex(i)} className="ghost-index relative isolate overflow-hidden bg-white">
              {/* Only the content rises, so the dividers and the ghost index hold still.
                  In two columns the second cell of each row trails by 120ms, and the outer
                  edges carry no padding so text lines up with the heading. */}
              <Reveal
                delay={(i % 2) * CARD_STAGGER}
                className={`h-full py-9 md:py-12 ${i % 2 === 0 ? 'md:pe-10' : 'md:ps-10'}`}
              >
                <h3 className="font-display text-2xl font-bold leading-snug text-ink">{item.title}</h3>
                <p className="mt-3 max-w-[34rem] text-[17px] leading-[1.85] text-muted">{typeset(item.body)}</p>
              </Reveal>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
