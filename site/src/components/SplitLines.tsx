import { Fragment, type CSSProperties } from 'react'
import { NBSP } from '../lib/typeset'

type Props = {
  lines: string[]
  lineClassName?: string
  sepClassName?: string
  // Below md, break the line before `//`: pins the wrap point so the heading's height doesn't
  // depend on which font has loaded (no layout shift on swap), and gives each half its own line
  breakBelowMd?: boolean
  // Wrap every word (and the `//`) in a .word span carrying its order in --w, for word-by-word
  // entrances. Words are whole inline-blocks, so Arabic letters never lose their joining.
  words?: boolean
}

type Segment = { text: string; light: boolean; sep?: true }

// Everything before the first `//` is bold (700), everything after is light (400),
// even when the heading spans several lines.
function toSegments(lines: string[]): Segment[][] {
  let light = false
  return lines.map((line) =>
    line.split('//').flatMap((text, i) => {
      const out: Segment[] = []
      if (i > 0) {
        light = true
        out.push({ text: '//', light, sep: true })
      }
      if (text.trim()) out.push({ text: text.trim(), light })
      return out
    }),
  )
}

export default function SplitLines({ lines, lineClassName = '', sepClassName = '', breakBelowMd = false, words = false }: Props) {
  // Air around `//` scales with the heading. When `//` opens a line (break below md), it gets
  // no leading margin, so that line stays flush with the others.
  const sepSpacing = breakBelowMd ? 'me-[0.22em] md:ms-[0.22em]' : 'mx-[0.22em]'
  let order = 0
  const wordProps = () => (words ? { className: 'word', style: { '--w': order++ } as CSSProperties } : {})

  return toSegments(lines).map((segments, i) => (
    <span key={i} className={`block ${lineClassName}`}>
      {segments.map((seg, j) => (
        <Fragment key={j}>
          {seg.sep && breakBelowMd && <br className="md:hidden" />}
          {/* `//` stays glued to the word after it, so a wrap never strands it at a line end */}
          {j > 0 && (segments[j - 1].sep ? NBSP : ' ')}
          {seg.sep ? (
            <span aria-hidden="true" className={`font-normal ${sepSpacing} ${sepClassName}`}>
              <span {...wordProps()}>//</span>
            </span>
          ) : (
            <span className={seg.light ? 'font-normal' : 'font-bold'}>
              {seg.text.split(' ').map((word, k) => (
                <Fragment key={k}>
                  {k > 0 && ' '}
                  {words ? <span {...wordProps()}>{word}</span> : word}
                </Fragment>
              ))}
            </span>
          )}
        </Fragment>
      ))}
    </span>
  ))
}
