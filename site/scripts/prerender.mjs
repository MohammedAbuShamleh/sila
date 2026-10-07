// Injects the server-rendered app into dist/index.html, then removes the temporary SSR bundle.
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ssrDir = resolve('dist-ssr')
const { render } = await import(pathToFileURL(resolve(ssrDir, 'entry-server.js')).href)

const file = resolve('dist/index.html')
const html = readFileSync(file, 'utf8')
const outlet = '<!--app-outlet-->'
if (!html.includes(outlet)) throw new Error(`prerender: ${outlet} not found in dist/index.html`)

writeFileSync(file, html.replace(outlet, render()))
rmSync(ssrDir, { recursive: true, force: true })
console.log('prerender: dist/index.html now ships the rendered page')
