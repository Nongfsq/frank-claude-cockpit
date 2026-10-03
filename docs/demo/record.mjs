// Steps the demo page's clock frame by frame in headless Chrome and writes PNG frames.
// Usage: node record.mjs <out-dir> [theme] [fps]   (needs `npm i puppeteer-core` and Google Chrome)
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const [out = 'frames', theme = 'dark', fps = '15', only = ''] = process.argv.slice(2)
const page_url = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'index.html')).href + `?theme=${theme}&t=0`
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

mkdirSync(out, { recursive: true })
const browser = await puppeteer.launch({ executablePath: chrome, headless: true })
const page = await browser.newPage()
await page.setViewport({ width: 1200, height: 720, deviceScaleFactor: 2 })
await page.goto(page_url)

const total = await page.evaluate(() => window.TOTAL)
const times = only === '' ? Array.from({ length: Math.ceil((total / 1000) * Number(fps)) }, (_, i) => (i * 1000) / Number(fps)) : only.split(',').map(Number)

for (const [index, t] of times.entries()) {
  await page.evaluate(ms => window.setT(ms), t)
  await page.screenshot({ path: join(out, only === '' ? `f${String(index).padStart(4, '0')}.png` : `t${t}.png`) })
}

await browser.close()
console.log(`${times.length} frames in ${out}`)
