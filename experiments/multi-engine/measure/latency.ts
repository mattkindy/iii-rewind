/**
 * Question 1: does the agent still work end to end, and what does each call add?
 * Calls engine A's port, 50034, which is also where the baseline listens:
 *   1. probe::echo 200 times in a row, after 20 to warm up.
 *   2. calendar::find-slot 40 times with a fresh attendee each time, and how long
 *      the tool itself took, read from the Rewind on the tools' engine.
 *   3. a burst of 30 agent runs through traffic::burst, with the runs Rewind recorded.
 *
 * Run from experiments/multi-engine with the setup up:
 *   npx tsx measure/latency.ts single     after `npx tsx start.ts --single`
 *   npx tsx measure/latency.ts split      after `npx tsx start.ts`
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { ENGINE_A, RESULTS_DIR, type Setup, connect, formatSummary, rewindDb, sleep, sqlite, summarize } from '../lib/engines.js'

const ECHO_CALLS = 200
const ECHO_WARMUP = 20
const SLOT_CALLS = 40
const BURST = { count: 30, interval_ms: 150 }

const TOOLS_ENGINE: Record<string, Setup> = { single: 'single', split: 'engine-b' }

const setup = process.argv[2] ?? ''
if (!(setup in TOOLS_ENGINE)) {
  console.error('usage: npx tsx measure/latency.ts single|split')
  process.exit(2)
}

const out: string[] = []
function say(line = ''): void {
  console.log(line)
  out.push(line)
}

const engine = connect(ENGINE_A, 'latency-probe')
const tag = `latency-${setup}-${Date.now()}`

async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
  const started = performance.now()
  try {
    const value = await work()
    return { ms: performance.now() - started, value }
  } catch (error) {
    return { ms: performance.now() - started, error }
  }
}

async function echo(): Promise<void> {
  for (let i = 0; i < ECHO_WARMUP; i++) {
    await engine.call('probe::echo', { warmup: i }, 10_000)
  }

  const times: number[] = []
  let failures = 0
  for (let i = 0; i < ECHO_CALLS; i++) {
    const result = await timed(() => engine.call('probe::echo', { i }, 10_000))
    times.push(result.ms)
    failures += result.error ? 1 : 0
  }

  say(formatSummary(`probe::echo round trip (${setup})`, summarize(times)))
  say(`  failures: ${failures}`)
}

type SlotRow = { input: string; duration_ms: number }

/** How long each tool call took inside the tools' own engine, read from that engine's Rewind. */
async function calleeDurations(): Promise<Map<string, number>> {
  const db = rewindDb(TOOLS_ENGINE[setup])
  for (let attempt = 0; attempt < 40; attempt++) {
    const rows = sqlite<SlotRow>(db, `select input, duration_ms from events where function_id = 'calendar::find-slot' and input like '%${tag}%'`)
    if (rows.length >= SLOT_CALLS) {
      return new Map(rows.map((row) => [JSON.parse(row.input).attendee as string, row.duration_ms]))
    }

    await sleep(250)
  }

  return new Map()
}

async function findSlot(): Promise<void> {
  const rtt = new Map<string, number>()
  let failures = 0
  let firstError: unknown
  for (let i = 0; i < SLOT_CALLS; i++) {
    const attendee = `${tag}-${i}@example.com`
    const result = await timed(() => engine.call('calendar::find-slot', { attendee, day: '2026-11-10', duration: 30 }, 10_000))
    rtt.set(attendee, result.ms)
    if (result.error) {
      failures += 1
      firstError ??= result.error
    }
  }

  say(formatSummary(`calendar::find-slot round trip (${setup})`, summarize([...rtt.values()])))
  say(`  failures: ${failures}${firstError ? `, first ${JSON.stringify(firstError)}` : ''}`)
  const callee = await calleeDurations()
  const overhead = [...rtt].filter(([attendee]) => callee.has(attendee)).map(([attendee, ms]) => ms - callee.get(attendee)!)
  say(formatSummary(`  inside the tool, from the tools' Rewind`, summarize([...callee.values()])))
  say(formatSummary(`  round trip minus time inside the tool`, summarize(overhead)))
}

type Run = { run_id: string; status: string; output?: { status?: string }; error?: { message?: string }; duration_ms: number; calls: number }

async function burst(): Promise<void> {
  const before = (await engine.call<{ runs: number }>('rewind::status')).runs
  const started = performance.now()
  const tally = await engine.call<Record<string, number>>('traffic::burst', BURST, 180_000)
  say(`traffic::burst ${JSON.stringify(BURST)} took ${((performance.now() - started) / 1000).toFixed(1)} s: ${JSON.stringify(tally)}`)
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await engine.call<{ runs: number }>('rewind::status')).runs >= before + BURST.count) {
      break
    }

    await sleep(250)
  }

  const runs = await engine.call<Run[]>('rewind::runs', { limit: BURST.count })
  const endings = new Map<string, number>()
  for (const run of runs) {
    const ending = run.status === 'error' ? `error: ${(run.error?.message ?? '').slice(0, 40)}` : `${run.status} ${run.output?.status}`
    endings.set(ending, (endings.get(ending) ?? 0) + 1)
  }

  say(`  Rewind recorded ${runs.length} runs: ${[...endings].map(([e, n]) => `${n} ${e}`).join(', ')}`)
  say(formatSummary('  agent::run duration', summarize(runs.map((r) => r.duration_ms))))
  say(formatSummary('  calls Rewind recorded per run (count, not ms)', summarize(runs.map((r) => r.calls))))
}

say(`Latency on ${setup}, engine ${ENGINE_A}, ${new Date().toISOString()}`)
try {
  await echo()
  await findSlot()
  await burst()
} finally {
  await engine.shutdown()
}

mkdirSync(RESULTS_DIR, { recursive: true })
writeFileSync(path.join(RESULTS_DIR, `latency-${setup}.txt`), `${out.join('\n')}\n`)
process.exit(0)
