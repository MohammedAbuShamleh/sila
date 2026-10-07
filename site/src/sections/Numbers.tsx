import CountUp from '../components/CountUp'
import { stats } from '../content'
import { useInView } from '../hooks/useInView'

export default function Numbers() {
  const [ref, state] = useInView<HTMLUListElement>()
  return (
    <section className="numbers text-white">
      <div className="page-wrap py-20 md:py-24">
        {/* Columns are as wide as their content (max-content), so the figures sit together as one
            group instead of spreading across the band. The group starts on the right, the band's
            dark side (see .numbers): one column on phones, two from sm, all four from lg. */}
        <ul
          ref={ref}
          className="grid gap-x-14 gap-y-12 sm:grid-cols-[repeat(2,max-content)] lg:grid-cols-[repeat(4,max-content)] xl:gap-x-16"
        >
          {stats.map((stat) => (
            <li key={stat.label}>
              <span className="block font-display text-[4.5rem] font-bold leading-none">
                <CountUp value={stat.value} play={state === 'entered'} />
              </span>
              <span className="mt-4 block max-w-[16ch] text-base leading-relaxed text-forest-50 md:text-[17px]">
                {stat.label}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
