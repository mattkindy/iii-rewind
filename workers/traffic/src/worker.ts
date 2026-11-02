/**
 * Load for the scheduling agent. traffic::burst sends booking requests to
 * agent::run, one every interval_ms, without waiting for the previous one to
 * finish, and counts how they ended.
 *
 * Requests come from fixed lists of attendees, durations and weekdays, so a
 * burst of 60 covers every combination once. Each run's outcome is printed as
 * one JSON line, which is how the planted bugs get counted.
 *
 * Run: III_URL=ws://127.0.0.1:49334 node --import tsx src/worker.ts
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { ROOT_CONTEXT, context } from '@opentelemetry/api'
import { registerWorker } from 'iii-sdk'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49334'
const ATTENDEES = ['Dana', 'Priya', 'Marcus', 'Lena', 'Omar', 'Sofia']
const DURATIONS = [15, 30, 45, 60]
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const DEFAULT_COUNT = 20
const DEFAULT_INTERVAL_MS = 400

type BurstInput = { count?: number; interval_ms?: number }
type BurstOutput = { sent: number; booked: number; failed: number; errors: number }
type Outcome = Exclude<keyof BurstOutput, 'sent'>
type RunOutput = { status: string; reply: string; turns: number }

const worker = registerWorker(ENGINE_URL, { workerName: 'traffic' })

function bookingRequest(index: number): string {
  const minutes = DURATIONS[index % DURATIONS.length]
  const attendee = ATTENDEES[index % ATTENDEES.length]
  const weekday = WEEKDAYS[index % WEEKDAYS.length]
  return `Book ${minutes} minutes with ${attendee} next ${weekday} afternoon`
}

// The SDK puts the handler's own error message in `message` and the thrown
// error's class in the first line of `stacktrace`, which is where SyntaxError shows.
function describeError(error: unknown) {
  const { code, message, stacktrace } = error as { code?: string; message?: string; stacktrace?: string }
  return { code, message, thrown: stacktrace?.split('\n')[0] }
}

// The SDK takes the traceparent it sends from the active OpenTelemetry context.
// Calling from the root context makes each run the root of a trace of its own,
// the way a request from outside would arrive, instead of one trace per burst.
function startRun(payload: { request: string; user: string }): Promise<RunOutput> {
  return context.with(ROOT_CONTEXT, () => worker.trigger<typeof payload, RunOutput>({ function_id: 'agent::run', payload }))
}

async function runOne(index: number): Promise<Outcome> {
  const payload = { request: bookingRequest(index), user: 'matt' }
  try {
    const result = await startRun(payload)
    console.log(JSON.stringify({ run: index, request: payload.request, ...result }))
    return result.status === 'booked' ? 'booked' : 'failed'
  } catch (error) {
    console.log(JSON.stringify({ run: index, request: payload.request, error: describeError(error) }))
    return 'errors'
  }
}

async function burst(input: BurstInput): Promise<BurstOutput> {
  const count = input.count ?? DEFAULT_COUNT
  const intervalMs = input.interval_ms ?? DEFAULT_INTERVAL_MS
  const runs: Promise<Outcome>[] = []
  for (let index = 0; index < count; index++) {
    if (index > 0) {
      await sleep(intervalMs)
    }

    runs.push(runOne(index))
  }

  const tally: Record<Outcome, number> = { booked: 0, failed: 0, errors: 0 }
  for (const outcome of await Promise.all(runs)) {
    tally[outcome] += 1
  }

  return { sent: count, ...tally }
}

const runCount = (description: string) => ({ type: 'integer', minimum: 0, description })

worker.registerFunction('traffic::burst', burst, {
  description: 'Sends a burst of booking requests to agent::run and counts the outcomes',
  metadata: { effects: ['writes'] },
  request_format: {
    type: 'object',
    properties: {
      count: { type: 'integer', minimum: 0, default: DEFAULT_COUNT, description: 'How many requests to send' },
      interval_ms: {
        type: 'integer',
        minimum: 0,
        default: DEFAULT_INTERVAL_MS,
        description: 'How long to wait between sending one request and the next, in milliseconds',
      },
    },
  },
  response_format: {
    type: 'object',
    properties: {
      sent: runCount('How many requests were sent'),
      booked: runCount('Runs that replied with status booked'),
      failed: runCount('Runs that replied with status failed'),
      errors: runCount('Runs that threw instead of replying'),
    },
    required: ['sent', 'booked', 'failed', 'errors'],
  },
})

console.log(`traffic ready on ${ENGINE_URL}`)
