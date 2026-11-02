/**
 * The clock for the scheduling agent. clock::now returns the current time in
 * America/Chicago with its UTC offset, for example 2026-10-27T15:02:11-05:00.
 *
 * The agent gets every date from here and never reads the system clock, so a
 * recording of this one call is enough to replay a run on another day.
 *
 * The same process runs the fake holiday and email providers on PROVIDERS_PORT,
 * which the agent and the tools worker call over plain HTTP, outside iii.
 *
 * Run: III_URL=ws://127.0.0.1:49334 node --import tsx src/worker.ts
 */
import { registerWorker } from 'iii-sdk'
import { serveProviders } from './providers.js'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49334'
const PROVIDERS_PORT = Number(process.env.PROVIDERS_PORT ?? 49335)
const TIME_ZONE = 'America/Chicago'

const chicagoParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'longOffset',
})

function chicagoNow(): string {
  const parts = Object.fromEntries(chicagoParts.formatToParts(new Date()).map((part) => [part.type, part.value]))
  // longOffset prints "GMT-05:00", or a bare "GMT" when the offset is zero.
  const offset = parts.timeZoneName.replace('GMT', '') || '+00:00'
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`
}

const worker = registerWorker(ENGINE_URL, { workerName: 'clock' })

worker.registerFunction('clock::now', async () => ({ now: chicagoNow() }), {
  description: 'The current time in America/Chicago, with its UTC offset',
  metadata: { effects: ['read-only'] },
  request_format: {
    type: 'object',
    description: 'Takes no arguments',
    properties: {},
  },
  response_format: {
    type: 'object',
    properties: {
      now: {
        type: 'string',
        format: 'date-time',
        description: 'The current time in America/Chicago with its UTC offset, such as 2026-10-27T15:02:11-05:00',
      },
    },
    required: ['now'],
  },
})

serveProviders(PROVIDERS_PORT)

console.log(`clock ready on ${ENGINE_URL}, providers on http://127.0.0.1:${PROVIDERS_PORT}`)
