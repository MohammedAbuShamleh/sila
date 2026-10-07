import { worksWith } from '../content'
import { sectionIds } from '../lib/sections'

export default function WorksWith() {
  const titleId = `${sectionIds.worksWith}-title`
  return (
    <section id={sectionIds.worksWith} aria-labelledby={titleId} className="border-y border-rule bg-forest-50">
      <div className="page-wrap flex flex-col gap-6 py-10 md:flex-row md:items-center md:gap-14 md:py-12">
        <h2 id={titleId} className="shrink-0 font-display text-xl font-bold text-forest-700">
          {worksWith.title}
        </h2>
        <ul className="grid flex-1 grid-cols-2 gap-x-6 gap-y-4 sm:flex sm:flex-wrap sm:items-center sm:justify-between">
          {worksWith.tools.map((tool) => (
            <li key={tool} className="text-lg font-bold text-ink md:text-xl">
              {tool}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
