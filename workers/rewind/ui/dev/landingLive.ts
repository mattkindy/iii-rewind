/**
 * Records Rewind's landing filling in from empty on a running stack: a burst of
 * 30 runs, then a second burst during which the tools worker is killed with
 * scripts/kill.ts, so the landing shows interrupted runs arriving too. It saves the
 * video and a still every 3 s, numbered by the second they were taken.
 *
 * Start the stack with an empty data folder first, so the video opens on the
 * empty state. Run from workers/rewind/ui:
 *   III_URL=ws://127.0.0.1:49734 CONSOLE_URL=http://127.0.0.1:3733 \
 *     COMPOSE_DIR=/folder/with/worker-compose.yaml III_BIN=/path/to/iii \
 *     OUT=/some/folder npx tsx dev/landingLive.ts
 * THEME=light records the light theme.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { registerWorker } from 'iii-sdk'
import { chromium } from 'playwright-core'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49734'
const CONSOLE_URL = process.env.CONSOLE_URL ?? 'http://127.0.0.1:3733'
const COMPOSE_DIR = process.env.COMPOSE_DIR ?? process.cwd()
const OUT = process.env.OUT ?? path.join(os.tmpdir(), 'rewind-landing-live')
const THEME = process.env.THEME === 'light' ? 'light' : 'dark'
const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const KILL_SCRIPT = path.resolve(UI_DIR, '../../../scripts/kill.ts')
const TSX = path.join(UI_DIR, 'node_modules/.bin/tsx')
const BURST = { count: 30, interval_ms: 300 }
const KILL_AFTER_MS = 3_000
const STILL_EVERY_MS = 3_000
const SIZE = { width: 1280, height: 860 }

const say = (text: string) => process.stdout.write(`${text}\n`)
const run = promisify(execFile)

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const iii = registerWorker(ENGINE_URL, { workerName: 'rewind-landing-live' })
const burst = () => iii.trigger({ function_id: 'traffic::burst', payload: BURST, timeoutMs: 180_000 })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: SIZE, colorScheme: THEME, recordVideo: { dir: OUT, size: SIZE } })
await context.addInitScript((theme) => window.localStorage.setItem('iii-theme', theme), THEME)
const page = await context.newPage()
page.on('pageerror', (error) => say(`pageerror: ${error.message}`))
await page.goto(`${CONSOLE_URL}/#/worker/rewind/rewind`)
await page.locator('[data-iii-ui="rewind"] .rw-empty').waitFor({ timeout: 60_000 })
const started = Date.now()

// A still every few seconds until the walk says stop.
let filming = true
const stills = (async () => {
  while (filming) {
    const second = Math.round((Date.now() - started) / 1000)
    await page.screenshot({ path: path.join(OUT, `still-${String(second).padStart(3, '0')}s.png`) }).catch(() => undefined)
    await sleep(STILL_EVERY_MS)
  }
})()

try {
  await sleep(2_000)
  say('first burst')
  say(JSON.stringify(await burst()))
  await sleep(3_000)
  say('second burst, killing tools a few seconds in')
  const second = burst()
  await sleep(KILL_AFTER_MS)
  const killed = await run(TSX, [KILL_SCRIPT, 'tools'], { cwd: COMPOSE_DIR, env: process.env })
  say(killed.stdout.trim())
  say(JSON.stringify(await second))
  // Long enough for the lost runs to arrive and the strip to show both bursts.
  await sleep(8_000)
} finally {
  filming = false
  await stills
  await context.close()
  await browser.close()
  const video = readdirSync(OUT).find((f) => f.endsWith('.webm'))
  if (video) {
    renameSync(path.join(OUT, video), path.join(OUT, 'landing-live.webm'))
  }

  await Promise.race([iii.shutdown(), sleep(3_000)])
}

say(`saved to ${OUT}`)
process.exit(0)
