import { existsSync } from 'node:fs'
import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { meta } from './src/content.ts'

// <title> and the description are injected from content.ts, so index.html carries no copy.
function pageMeta(): Plugin {
  return {
    name: 'page-meta',
    transformIndexHtml: () => [
      { tag: 'title', children: meta.title, injectTo: 'head' },
      { tag: 'meta', attrs: { name: 'description', content: meta.description }, injectTo: 'head' },
    ],
  }
}

// Thmanyah Sans (headings and figures) is defined only when its files are present in
// public/fonts/thmanyah. They are git-ignored (see .gitignore: the license forbids hosting them),
// so a CI build or a fresh clone simply renders the next family in the stack, Reem Kufi.
const THMANYAH_DIR = 'fonts/thmanyah'
// Only the weights the page uses: headings are 700 // 400, figures and the wordmark 700
const THMANYAH_WEIGHTS: [string, number][] = [
  ['Regular', 400],
  ['Bold', 700],
]
// One preload: the weight the hero title opens with
const THMANYAH_PRELOAD = ['Bold']

function localDisplayFont(): Plugin {
  return {
    name: 'local-display-font',
    transformIndexHtml: () => {
      if (!existsSync(`public/${THMANYAH_DIR}/thmanyahsans-Bold.woff2`)) return []
      const file = (name: string) => `./${THMANYAH_DIR}/thmanyahsans-${name}.woff2`
      // Declare only the weights whose files are present, so a missing file never becomes a 404
      const present = THMANYAH_WEIGHTS.filter(([name]) => existsSync(`public/${THMANYAH_DIR}/thmanyahsans-${name}.woff2`))
      const faces = present.map(
        ([name, weight]) =>
          `@font-face{font-family:"Thmanyah Sans";src:url("${file(name)}") format("woff2");font-weight:${weight};font-style:normal;font-display:swap}`,
      ).join('')
      const preloads: HtmlTagDescriptor[] = THMANYAH_PRELOAD.map((name) => ({
        tag: 'link',
        attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: file(name), crossorigin: '' },
        injectTo: 'head',
      }))
      return [...preloads, { tag: 'style', children: faces, injectTo: 'head' }]
    },
  }
}

// GitHub Pages serves a project repository under /<repo>/ and a user repository or custom domain
// at /. pages.yml passes the path actions/configure-pages reports for this repository, so the
// published asset URLs are absolute and right for whichever it is. Everywhere else (dev, a local
// build, preview) the base stays relative, which a single page with no router can afford.
const pagesBase = process.env.PAGES_BASE_PATH

export default defineConfig({
  plugins: [react(), pageMeta(), localDisplayFont()],
  base: pagesBase === undefined ? './' : `${pagesBase}/`,
  server: {
    // On this machine the native file watcher dropped edits and never saw new files, so a
    // running dev server kept serving stale modules and a CSS build missing whole sections.
    // Polling costs a little CPU and never misses a change. Dev server only.
    watch: { usePolling: true, interval: 200 },
  },
})
