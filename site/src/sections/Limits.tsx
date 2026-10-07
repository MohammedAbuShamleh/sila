import SectionHeading from '../components/SectionHeading'
import SlashMark from '../components/SlashMark'
import { limits } from '../content'
import { sectionIds } from '../lib/sections'
import { typeset } from '../lib/typeset'

export default function Limits() {
  const titleId = `${sectionIds.limits}-title`
  return (
    <section id={sectionIds.limits} aria-labelledby={titleId} className="bg-white">
      {/* From lg: heading column on the right stays put (sticky, clear of the 56px header)
          while the limits pass by on the left. Below lg the two simply stack. */}
      <div className="page-wrap py-24 md:py-32 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-x-20">
        <div className="lg:sticky lg:top-[88px] lg:self-start">
          <SectionHeading id={titleId} text={limits.title} className="text-ink" />
          <p className="mt-6 max-w-[40rem] text-lg leading-[1.85] text-muted md:text-xl md:leading-[1.8]">
            {typeset(limits.lead)}
          </p>
        </div>

        <ul className="mt-14 grid gap-x-16 gap-y-12 md:mt-20 md:grid-cols-2 lg:mt-1 lg:grid-cols-1 lg:gap-y-16">
          {limits.items.map((item) => (
            <li key={item.title} className="flex gap-4">
              <SlashMark className="mt-2 h-4 w-5 shrink-0 text-forest-300" />
              <div>
                <h3 className="font-display text-xl font-bold leading-snug text-ink md:text-2xl">{item.title}</h3>
                <p className="mt-2 text-[17px] leading-[1.85] text-muted">{typeset(item.body)}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
