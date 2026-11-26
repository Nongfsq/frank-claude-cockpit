// Steps the demo page's clock frame by frame in headless Chrome and writes PNG frames.
// Usage: node record.mjs <out-dir> [theme] [fps] [times]   (needs `npm i puppeteer-core` and Google Chrome)
//        node record.mjs docs <theme> still                 the README still, docs/card-<theme>.png
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const [out = 'frames', theme = 'dark', fps = '15', only = ''] = process.argv.slice(2)
const isStill = fps === 'still'
const page_url = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'index.html')).href + `?theme=${theme}&t=0${isStill ? '&still' : ''}`
const chrome =
  process.env.CHROME ??
  (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')

mkdirSync(out, { recursive: true })
const browser = await puppeteer.launch({ executablePath: chrome, headless: true })
const page = await browser.newPage()
await page.setViewport({ width: 1200, height: 720, deviceScaleFactor: 2 })
await page.goto(page_url)

if (isStill) {
  const clip = await page.evaluate(() => window.SHOT())
  await page.screenshot({ path: join(out, `card-${theme}.png`), clip })
  await browser.close()
  console.log(`card-${theme}.png in ${out}`)
  process.exit(0)
}

const total = await page.evaluate(() => window.TOTAL)
const times = only === '' ? Array.from({ length: Math.ceil((total / 1000) * Number(fps)) }, (_, i) => (i * 1000) / Number(fps)) : only.split(',').map(Number)

for (const [index, t] of times.entries()) {
  await page.evaluate(ms => window.setT(ms), t)
  await page.screenshot({ path: join(out, only === '' ? `f${String(index).padStart(4, '0')}.png` : `t${t}.png`) })
}

await browser.close()
console.log(`${times.length} frames in ${out}`)
