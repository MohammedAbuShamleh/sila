import { Fragment } from 'react'
import { footer } from '../content'
import LogoMark from './LogoMark'

export default function SiteFooter() {
  const [name, ...rest] = footer.credits
  return (
    <footer className="bg-forest-900 text-forest-100 [--focus:theme(colors.forest.100)]">
      <div className="page-wrap flex flex-col gap-8 py-12 md:flex-row md:items-center md:justify-between">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[15px]">
          <span className="flex items-center gap-2 text-white">
            <LogoMark className="h-7 w-7" />
            <span className="font-display text-xl font-bold">{name}</span>
          </span>
          {rest.map((part) => (
            <Fragment key={part}>
              <span aria-hidden="true" className="h-1 w-1 rounded-full bg-forest-300" />
              <span>{part}</span>
            </Fragment>
          ))}
        </p>

        <nav aria-label={footer.navLabel}>
          <ul className="flex flex-wrap gap-x-7 gap-y-3">
            {footer.links.map((link) => (
              <li key={link.label}>
                <a href={link.href} className="link-draw text-[15px] font-medium text-forest-50">
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  )
}
