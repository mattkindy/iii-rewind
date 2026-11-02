/**
 * Questions 2 and 4: what an observer on each engine sees of a tool call, and
 * whether the two Rewind recordings of one run can be joined.
 *
 * It lists the tools on each engine, observes them on each engine with every
 * capture on, runs the agent until it has seen a slot lookup and a send, and
 * calls find-slot once with bug 2's string duration. On `split` it then turns
 * recording on for the bridged tools in Rewind A, runs the agent again, and
 * tries to join Rewind A's rows to Rewind B's by invocation id, trace id, and
 * input and time.
 *
 * Run from experiments/multi-engine with the setup up:
 *   npx tsx measure/envelope.ts single | split
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { ENGINE_A, ENGINE_B, RESULTS_DIR, type Engine, connect, functions, inDefault, rewindDb, sleep, sqlite } from '../lib/engines.js'

const TOOLS = ['calendar::find-slot', 'email::send', 'probe::echo']
const REQUESTS = [
  'Book 30 minutes with Dana next Tuesday afternoon',
  'Book 45 minutes with Priya next Wednesday afternoon',
  'Book 60 minutes with Marcus next Thursday afternoon',
  'Book 15 minutes with Lena next Friday afternoon',
  'Book 30 minutes with Omar next Monday afternoon',
  'Book 45 minutes with Sofia next Tuesday afternoon',
]

const setup = process.argv[2] ?? ''
if (setup !== 'single' && setup !== 'split') {
  console.error('usage: npx tsx measure/envelope.ts single|split')
  process.exit(2)
}

const out: string[] = []
function say(line = ''): void {
  console.log(line)
  out.push(line)
}

type Envelope = { function_id: string; invocation_id: string; status: string; input?: unknown; caller?: Record<string, unknown>; started_at_ms: number }

const a = connect(ENGINE_A, 'envelope-probe')
const b = setup === 'split' ? connect(ENGINE_B, 'envelope-probe') : undefined
const engines: [string, Engine][] = b ? [['A', a], ['B', b]] : [['single', a]]
const seen = new Map<string, Envelope[]>(engines.map(([label]) => [label, []]))

async function listTools(): Promise<void> {
  say('1. The tools in each engine\'s function list')
  for (const [label, engine] of engines) {
    const rows = (await functions(engine)).filter((row) => inDefault(row) && TOOLS.includes(row.function_id))
    for (const row of rows) {
      say(`  ${label}: ${row.function_id} worker=${row.worker_name} metadata=${JSON.stringify(row.metadata ?? null)} description=${JSON.stringify(row.description ?? null)}`)
    }
  }
}

type RewindFunction = { function_id: string; worker: string; effects: string[]; recording: boolean }

async function rewindView(engine: Engine, label: string): Promise<void> {
  const rows = await engine.call<RewindFunction[]>('rewind::functions')
  for (const row of rows.filter((r) => TOOLS.includes(r.function_id))) {
    say(`  Rewind ${label}: ${JSON.stringify(row)}`)
  }

  const status = await engine.call<{ recording: string[] }>('rewind::status')
  say(`  Rewind ${label} records: ${status.recording.join(', ')}`)
}

async function observeTools(): Promise<void> {
  for (const [label, engine] of engines) {
    const target = `iii::envelope-probe::${label.toLowerCase()}`
    engine.worker.registerFunction(target, async (envelope: Envelope) => {
      seen.get(label)!.push(envelope)
      return null
    })
    await sleep(500)
    for (const functionId of TOOLS.slice(0, 2)) {
      const handle = engine.worker.observe(
        { function_id: functionId, on: 'complete', capture: ['input', 'output', 'error', 'caller', 'metadata'] },
        target,
      )
      await handle.ready()
    }
  }
}

/** JSON with each stacktrace cut to its last line, which says what was raised. */
function shown(value: unknown): string {
  return JSON.stringify(value, (key, field) => {
    if (key !== 'stacktrace' || typeof field !== 'string') {
      return field
    }

    const last = field.trim().split('\n').at(-1)
    return `... ${last}`
  })
}

function caught(error: unknown): unknown {
  const { code, message, stacktrace } = error as { code?: string; message?: string; stacktrace?: string }
  return { caught: { code, message, stacktrace } }
}

function print(label: string, envelope: Envelope): void {
  say(`  ${label} saw ${shown(envelope)}`)
}

async function waitForEnvelopes(count: number, matches: (e: Envelope) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if ([...seen.values()].every((list) => list.filter(matches).length >= count)) {
      return
    }

    await sleep(250)
  }
}

async function agentRuns(): Promise<void> {
  say('2. Agent runs, until each engine has seen a slot lookup and a send')
  for (const request of REQUESTS) {
    const output = await a.call('agent::run', { request, user: 'matt' }).catch(caught)
    say(`  agent::run "${request}" -> ${shown(output)}`)
    await waitForEnvelopes(1, (e) => e.function_id === 'email::send')
    const all = [...seen.values()]
    if (all.every((list) => list.some((e) => e.function_id === 'email::send') && list.some((e) => e.function_id === 'calendar::find-slot' && e.status === 'success'))) {
      break
    }
  }

  for (const [label] of engines) {
    const list = seen.get(label)!
    const slot = list.find((e) => e.function_id === 'calendar::find-slot' && e.status === 'success')
    const send = list.find((e) => e.function_id === 'email::send')
    for (const envelope of [slot, send]) {
      if (envelope) {
        print(label, envelope)
      }
    }
  }
}

async function bug2(): Promise<void> {
  say('3. calendar::find-slot called directly with a string duration (bug 2)')
  const attendee = `bug2-${setup}-${Date.now()}@example.com`
  const result = await a.call('calendar::find-slot', { attendee, day: '2026-11-10', duration: '30' }, 10_000).catch(caught)
  say(`  the caller on ${ENGINE_A} got ${shown(result)}`)
  const isThis = (e: Envelope) => JSON.stringify(e.input ?? {}).includes(attendee)
  await waitForEnvelopes(1, isThis)
  for (const [label] of engines) {
    const envelope = seen.get(label)!.find(isThis)
    if (!envelope) {
      say(`  ${label} saw nothing`)
      continue
    }

    print(label, envelope)
  }
}

type Row = {
  invocation_id: string
  function_id: string
  input: string
  caller_worker: string | null
  caller_function_id: string | null
  caller_invocation_id: string | null
  trace_id: string | null
  started_at_ms: number
  duration_ms: number
}

const ROW_COLUMNS = 'invocation_id, function_id, input, caller_worker, caller_function_id, caller_invocation_id, trace_id, started_at_ms, duration_ms'

function rowsSince(db: string, sinceMs: number): Row[] {
  return sqlite<Row>(db, `select ${ROW_COLUMNS} from events where function_id in ('calendar::find-slot', 'email::send') and started_at_ms >= ${sinceMs} order by started_at_ms`)
}

function describe(row: Row): string {
  return `${row.function_id} inv=${row.invocation_id} caller_worker=${row.caller_worker} caller_function=${row.caller_function_id} caller_inv=${row.caller_invocation_id} trace=${row.trace_id} start=${row.started_at_ms} dur=${row.duration_ms.toFixed(1)}`
}

/** Tries each way of pairing a call Rewind A recorded with the one Rewind B recorded. */
function joinAttempts(aRows: Row[], bRows: Row[]): void {
  for (const bRow of bRows) {
    const byInvocation = aRows.find((r) => r.invocation_id === bRow.invocation_id || r.invocation_id === bRow.caller_invocation_id)
    const byTrace = aRows.find((r) => r.trace_id !== null && r.trace_id === bRow.trace_id)
    const byInput = aRows.filter(
      (r) => r.function_id === bRow.function_id && isDeepStrictEqual(JSON.parse(r.input), JSON.parse(bRow.input)) && Math.abs(r.started_at_ms - bRow.started_at_ms) <= 50,
    )
    say(`  B ${bRow.function_id} ${bRow.invocation_id}: by invocation id ${byInvocation?.invocation_id ?? 'no match'}, by trace id ${byTrace?.invocation_id ?? 'no match'}, by input and start within 50 ms ${byInput.map((r) => r.invocation_id).join(', ') || 'no match'}`)
  }
}

async function recordBothSides(): Promise<void> {
  say('4. Rewind A before and after turning recording on for the bridged tools')
  await rewindView(a, 'A')
  for (const functionId of TOOLS.slice(0, 2)) {
    await a.call('rewind::record-toggle', { function_id: functionId, enabled: true })
  }

  await sleep(1_500)
  await rewindView(a, 'A')
  await rewindView(b!, 'B')

  say('5. One more agent run, recorded on both engines')
  const since = Date.now()
  for (const request of REQUESTS) {
    const output = await a.call('agent::run', { request, user: 'matt' }).catch(caught)
    say(`  agent::run "${request}" -> ${shown(output)}`)
    await sleep(2_500)
    if (rowsSince(rewindDb('engine-b'), since).some((r) => r.function_id === 'email::send')) {
      break
    }
  }

  const aRows = rowsSince(rewindDb('engine-a'), since)
  const bRows = rowsSince(rewindDb('engine-b'), since)
  for (const row of aRows) {
    say(`  Rewind A row: ${describe(row)}`)
  }

  for (const row of bRows) {
    say(`  Rewind B row: ${describe(row)}`)
  }

  joinAttempts(aRows, bRows)
}

say(`Envelopes on ${setup}, ${new Date().toISOString()}`)
try {
  await listTools()
  await rewindView(a, engines[0][0])
  await observeTools()
  await agentRuns()
  await bug2()
  if (b) {
    await recordBothSides()
  }
} finally {
  await Promise.all(engines.map(([, engine]) => engine.shutdown()))
}

mkdirSync(RESULTS_DIR, { recursive: true })
writeFileSync(path.join(RESULTS_DIR, `envelope-${setup}.txt`), `${out.join('\n')}\n`)
process.exit(0)
