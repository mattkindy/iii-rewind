/**
 * Question 3: does a run that crosses the bridge stay one trace?
 *
 * It sends one booking through traffic::burst, so the run starts inside a
 * handler the way the demo's runs do, and takes the run's trace id from Rewind A.
 * Then it asks engine::traces::spans on each engine for that trace, and for the
 * tool spans engine B stored while the run was going, with their trace ids.
 *
 * Run from experiments/multi-engine with the setup up:
 *   npx tsx measure/traces.ts single | split
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ENGINE_A, ENGINE_B, RESULTS_DIR, type Engine, connect, sleep } from '../lib/engines.js'

const setup = process.argv[2] ?? ''
if (setup !== 'single' && setup !== 'split') {
  console.error('usage: npx tsx measure/traces.ts single|split')
  process.exit(2)
}

const out: string[] = []
function say(line = ''): void {
  console.log(line)
  out.push(line)
}

type StoredSpan = {
  trace_id: string
  span_id: string
  parent_span_id?: string | null
  name: string
  service_name: string
  start_time_unix_nano: number
  end_time_unix_nano: number
}
type Run = { run_id: string; status: string; output?: { status?: string }; trace_id?: string; started_at_ms: number; duration_ms: number; calls: number }
type Call = { seq: number; function_id: string; trace_id?: string; span_id?: string; invocation_id?: string }

const a = connect(ENGINE_A, 'traces-probe')
const b = setup === 'split' ? connect(ENGINE_B, 'traces-probe') : undefined

async function spans(engine: Engine, query: Record<string, unknown>): Promise<StoredSpan[]> {
  const found: StoredSpan[] = []
  for (let offset = 0; offset < 5_000; offset += 500) {
    const page = await engine.call<{ spans: StoredSpan[] }>('engine::traces::spans', {
      ...query,
      search_all_spans: true,
      include_events: false,
      offset,
      limit: 500,
    })
    found.push(...page.spans)
    if (page.spans.length < 500) {
      break
    }
  }

  return found
}

type SpanWithEvents = StoredSpan & { attributes: [string, string][]; events: { name: string; attributes: [string, string][] }[] }

/** What a trace store keeps about one span: its attribute keys, and each event with its attributes cut short. */
async function contents(engine: Engine, label: string, traceId: string, spanName: string, service: string): Promise<void> {
  const page = await engine.call<{ spans: SpanWithEvents[] }>('engine::traces::spans', { trace_id: traceId, search_all_spans: true, include_events: true, limit: 500 })
  const span = page.spans.find((s) => s.name === spanName && s.service_name === service)
  if (!span) {
    say(`  ${label}: no ${service}: ${spanName} span`)
    return
  }

  say(`  ${label} ${service}: ${spanName} attributes: ${span.attributes.map(([key]) => key).join(', ')}`)
  for (const event of span.events) {
    say(`    event ${event.name}: ${event.attributes.map(([key, value]) => `${key}=${value.slice(0, 160)}`).join('; ')}`)
  }
}

function tally(list: StoredSpan[]): string {
  const counts = new Map<string, number>()
  for (const span of list) {
    const key = `${span.service_name}: ${span.name}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return [...counts].map(([key, n]) => `${n} x ${key}`).join('; ')
}

/** A booked run that called both tools, sent the way traffic sends them. */
async function bookedRun(): Promise<Run | undefined> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await a.call('traffic::burst', { count: 1 }, 60_000)
    await sleep(2_500)
    const [run] = await a.call<Run[]>('rewind::runs', { limit: 1 })
    if (run?.output?.status === 'booked') {
      return run
    }
  }

  return undefined
}

async function main(): Promise<void> {
  const run = await bookedRun()
  if (!run) {
    say('no booked run in 8 tries')
    return
  }

  const detail = await a.call<{ calls: Call[] }>('rewind::run', { run_id: run.run_id })
  say(`run ${run.run_id}, trace ${run.trace_id}, ${run.calls} calls recorded by Rewind A`)
  for (const call of detail.calls) {
    say(`  seq ${call.seq} ${call.function_id} trace=${call.trace_id ?? '-'} span=${call.span_id ?? '-'}`)
  }

  await sleep(3_000)
  const onA = await spans(a, { trace_id: run.trace_id })
  say(`engine A has ${onA.length} spans in trace ${run.trace_id}: ${tally(onA)}`)
  if (!b) {
    return
  }

  const onB = await spans(b, { trace_id: run.trace_id })
  say(`engine B has ${onB.length} spans in trace ${run.trace_id}: ${tally(onB)}`)
  for (const span of onB) {
    const parent = onA.find((s) => s.span_id === span.parent_span_id) ?? onB.find((s) => s.span_id === span.parent_span_id)
    const where = onA.includes(parent as StoredSpan) ? 'on A' : 'on B'
    say(`  B span ${span.service_name}: ${span.name}, parent ${parent ? `${where} ${parent.service_name}: ${parent.name}` : `${span.parent_span_id ?? 'none'}, not stored on either engine`}`)
  }

  const window = { start_time: run.started_at_ms - 100, end_time: Math.ceil(run.started_at_ms + run.duration_ms + 100) }
  const toolSpans = (await spans(b, window)).filter((s) => /calendar::find-slot|email::send/.test(s.name))
  const traces = [...new Set(toolSpans.map((s) => s.trace_id))]
  say(`engine B stored ${toolSpans.length} tool spans during the run, in ${traces.length} trace(s): ${traces.join(', ')}`)
  for (const traceId of traces) {
    const all = await spans(b, { trace_id: traceId })
    const root = all.find((s) => !s.parent_span_id || !all.some((p) => p.span_id === s.parent_span_id))
    const parentOnA = root?.parent_span_id ? onA.find((s) => s.span_id === root.parent_span_id) : undefined
    say(`  B trace ${traceId}: ${tally(all)}`)
    say(`    its root ${root?.service_name}: ${root?.name} has parent ${root?.parent_span_id ?? 'none'}${parentOnA ? `, which is A's span ${parentOnA.service_name}: ${parentOnA.name}` : ''}`)
    const onAToo = await spans(a, { trace_id: traceId })
    say(`    engine A has ${onAToo.length} spans in this trace`)
  }

  say("What each engine's trace store keeps of a call that crossed the bridge")
  await contents(a, 'engine A', run.trace_id!, 'execute email::send', 'bridge')
  await contents(b, 'engine B', run.trace_id!, 'execute email::send', 'iii-python-sdk')
  await contents(b, 'engine B', run.trace_id!, 'POST /email', 'iii-python-sdk')
}

say(`Traces on ${setup}, ${new Date().toISOString()}`)
try {
  await main()
} finally {
  await a.shutdown()
  await b?.shutdown()
}

mkdirSync(RESULTS_DIR, { recursive: true })
writeFileSync(path.join(RESULTS_DIR, `traces-${setup}.txt`), `${out.join('\n')}\n`)
process.exit(0)
