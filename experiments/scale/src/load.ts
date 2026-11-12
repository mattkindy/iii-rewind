/**
 * Sends scale::run-<lane> at a fixed rate for a fixed time, without waiting for one
 * run before starting the next, and prints one JSON line with what it sent and how
 * those runs ended. The bench starts one of these per lane for each step.
 *
 * A run that would start while MAX_IN_FLIGHT runs are still open is skipped and
 * counted, so a saturated app shows up as skips instead of an ever longer queue.
 *
 * Run: III_URL=ws://127.0.0.1:49534 npx tsx src/load.ts <lane> <runs per second> <seconds> <fanout> <pad bytes>
 */
import { ROOT_CONTEXT, context } from '@opentelemetry/api'
import { setTimeout as sleep } from 'node:timers/promises'
import { registerWorker } from 'iii-sdk'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49534'
const MAX_IN_FLIGHT = 4000
const TICK_MS = 5

const [lane, rateText, secondsText, fanoutText, padText] = process.argv.slice(2)
const runsPerSecond = Number(rateText)
const seconds = Number(secondsText)
const fanout = Number(fanoutText ?? 9)
const pad = 'x'.repeat(Number(padText ?? 512))

type RunOutput = { calls: number; failed: number }

const worker = registerWorker(ENGINE_URL, { workerName: `scale-load-${lane}` })
const latencies: number[] = []
const tally = { sent: 0, done: 0, errors: 0, skipped: 0, calls_made: 0, inner_failed: 0 }
let inFlight = 0

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0
  }

  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

// Each run starts from the root context, so it is the root of its own trace, as in traffic::burst.
async function oneRun(): Promise<void> {
  const started = performance.now()
  inFlight += 1
  try {
    const output = await context.with(ROOT_CONTEXT, () =>
      worker.trigger<unknown, RunOutput>({ function_id: `scale::run-${lane}`, payload: { fanout, pad }, timeoutMs: 60_000 }),
    )
    tally.done += 1
    tally.calls_made += 1 + output.calls
    tally.inner_failed += output.failed
    latencies.push(performance.now() - started)
  } catch {
    tally.errors += 1
    tally.calls_made += 1
  } finally {
    inFlight -= 1
  }
}

async function main(): Promise<void> {
  // The first trigger waits for the connection, so warm it up before the clock starts.
  await worker.trigger({ function_id: 'engine::functions::list', payload: { prefix: `scale::run-${lane}` }, timeoutMs: 30_000 })
  const runs: Promise<void>[] = []
  const startedAt = performance.now()
  const endAt = startedAt + seconds * 1000
  while (performance.now() < endAt) {
    const due = Math.floor(((performance.now() - startedAt) / 1000) * runsPerSecond)
    while (tally.sent + tally.skipped < due) {
      if (inFlight >= MAX_IN_FLIGHT) {
        tally.skipped += 1
        continue
      }

      tally.sent += 1
      runs.push(oneRun())
    }

    await sleep(TICK_MS)
  }

  const sendingMs = performance.now() - startedAt
  await Promise.all(runs)
  const sorted = latencies.sort((a, b) => a - b)
  const result = {
    lane: Number(lane),
    ...tally,
    sending_ms: Math.round(sendingMs),
    finished_ms: Math.round(performance.now() - startedAt),
    run_ms_p50: Math.round(percentile(sorted, 50)),
    run_ms_p99: Math.round(percentile(sorted, 99)),
  }
  console.log(JSON.stringify(result))
  await worker.shutdown()
  process.exit(0)
}

void main()
