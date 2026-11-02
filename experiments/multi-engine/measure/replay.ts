/**
 * Question 5: replay and forks on engine A when the tools are on engine B.
 *
 * 1. Replays a booked run whose tool calls Rewind recorded, and checks that
 *    nothing reached the tools: the outbox, an observer on the tools' engine,
 *    and the Rewind there. On `split` it also replays a run recorded before
 *    recording was turned on for the bridged tools.
 * 2. Forks that run onto another day, so find-slot gets new input, and tries to run it live.
 * 3. Kills the worker that owns find-slot on engine A (the bridge on `split`,
 *    tools on `single`), replays while it is gone, then again once it is back.
 *
 * Run from experiments/multi-engine with the setup up:
 *   npx tsx measure/replay.ts single | split
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ENGINE_A, ENGINE_B, OUTBOX_A, OUTBOX_SINGLE, RESULTS_DIR, type Setup, connect, functions, inDefault, lines, rewindDb, sleep, sqlite, workerPid } from '../lib/engines.js'

type Answer = { value: unknown } | { error: { code?: string; message: string } }
type Call = { seq: number; function_id: string; effects: string[]; input: unknown; answer: Answer; source: string }
type Need = { seq: number; function_id: string; input: unknown; effects: string[]; choices: string[] }
type Outcome = { state: 'done'; output: unknown } | { state: 'crashed'; error: { code?: string; message: string } } | { state: 'paused'; need: Need }
type Fork = { fork_id: string; namespace: string; calls: Call[]; outcome: Outcome }
type Run = { run_id: string; status: string; output?: { status?: string }; started_at_ms: number; calls: number }
type RunDetail = { run: Run; calls: Call[] }
type Envelope = { function_id: string; input?: unknown; caller?: { worker_name?: string }; status: string }

type Layout = { toolsEngine: string; toolsSetup: Setup; outbox: string; ownerSetup: Setup; owner: string }

const LAYOUT: Record<string, Layout> = {
  single: { toolsEngine: ENGINE_A, toolsSetup: 'single', outbox: OUTBOX_SINGLE, ownerSetup: 'single', owner: 'tools' },
  split: { toolsEngine: ENGINE_B, toolsSetup: 'engine-b', outbox: OUTBOX_A, ownerSetup: 'engine-a', owner: 'bridge' },
}

const setup = process.argv[2] ?? ''
const layout = LAYOUT[setup]
if (!layout) {
  console.error('usage: npx tsx measure/replay.ts single|split')
  process.exit(2)
}

const out: string[] = []
function say(line = ''): void {
  console.log(line)
  out.push(line)
}

const a = connect(ENGINE_A, 'replay-probe')
const tools = layout.toolsEngine === ENGINE_A ? a : connect(layout.toolsEngine, 'replay-probe')
const reached: Envelope[] = []

const DESCRIBE: Record<Outcome['state'], (o: Outcome) => string> = {
  done: (o) => `done ${JSON.stringify((o as { output: unknown }).output)}`,
  crashed: (o) => `crashed ${JSON.stringify((o as { error: unknown }).error)}`,
  paused: (o) => {
    const need = (o as { need: Need }).need
    return `paused at seq ${need.seq} ${need.function_id}, effects ${JSON.stringify(need.effects)}, choices ${need.choices.join(', ')}, input ${JSON.stringify(need.input)}`
  },
}

function describe(outcome: Outcome): string {
  return DESCRIBE[outcome.state](outcome)
}

function sources(fork: Fork): string {
  return fork.calls.map((c) => `${c.seq}:${c.function_id}=${c.source}`).join(' ')
}

function toolEvents(): number {
  return sqlite<{ n: number }>(rewindDb(layout.toolsSetup), "select count(*) as n from events where function_id in ('calendar::find-slot', 'email::send')")[0].n
}

type Snapshot = { outbox: number; toolEvents: number; reached: number }

function snapshot(): Snapshot {
  return { outbox: lines(layout.outbox).length, toolEvents: toolEvents(), reached: reached.length }
}

function changed(before: Snapshot, after: Snapshot): string {
  return `outbox ${before.outbox} -> ${after.outbox} lines, tools' Rewind ${before.toolEvents} -> ${after.toolEvents} tool rows, observer on the tools' engine saw ${after.reached - before.reached} call(s)`
}

async function observeTools(): Promise<void> {
  tools.worker.registerFunction('iii::replay-probe::reached', async (envelope: Envelope) => {
    reached.push(envelope)
    return null
  })
  await sleep(500)
  for (const functionId of ['calendar::find-slot', 'email::send']) {
    await tools.worker.observe({ function_id: functionId, on: 'complete', capture: ['input', 'output', 'error', 'caller'] }, 'iii::replay-probe::reached').ready()
  }
}

/** The newest booked run whose recording has both tool calls, and, on split, one recorded without them. */
async function pickRuns(): Promise<{ withTools?: RunDetail; withoutTools?: RunDetail }> {
  const runs = await a.call<Run[]>('rewind::runs', { limit: 200 })
  let withTools: RunDetail | undefined
  let withoutTools: RunDetail | undefined
  for (const run of runs.filter((r) => r.output?.status === 'booked')) {
    const detail = await a.call<RunDetail>('rewind::run', { run_id: run.run_id })
    const ids = detail.calls.map((c) => c.function_id)
    const hasTools = ids.includes('calendar::find-slot') && ids.includes('email::send')
    withTools ??= hasTools ? detail : undefined
    withoutTools ??= !hasTools && ids.includes('model::complete') ? detail : undefined
    if (withTools && withoutTools) {
      break
    }
  }

  return { withTools, withoutTools }
}

async function replay(label: string, detail: RunDetail): Promise<Fork> {
  const before = snapshot()
  const fork = await a.call<Fork>('rewind::replay', { run_id: detail.run.run_id })
  await sleep(1_500)
  say(`  ${label}: run ${detail.run.run_id} (${detail.calls.length} recorded calls: ${detail.calls.map((c) => c.function_id).join(', ')})`)
  say(`    replayed as ${fork.fork_id} in ${fork.namespace}: ${describe(fork.outcome)}`)
  say(`    calls ${sources(fork)}`)
  say(`    ${changed(before, snapshot())}`)
  return fork
}

const TYPED: Record<string, (need: Need) => unknown> = {
  'calendar::find-slot': (need) => {
    const input = need.input as { attendee: string; day: string; duration: number }
    return { attendee: input.attendee, start: `${input.day}T14:00:00-06:00`, end: `${input.day}T14:30:00-06:00` }
  },
  'email::send': () => ({ status: 'accepted', id: 'msg_multi_engine' }),
}

/** Tries live for find-slot first, then answers each pause live when a person could and types an answer otherwise. */
async function answerPauses(fork: Fork): Promise<Fork> {
  let current = fork
  for (let pause = 0; pause < 10 && current.outcome.state === 'paused'; pause++) {
    const need = current.outcome.need
    if (need.function_id === 'calendar::find-slot') {
      const before = snapshot()
      const live = await a.call<Fork>('rewind::answer', { fork_id: current.fork_id, choice: 'live' }).catch((error) => error as { code?: string; message?: string })
      await sleep(1_500)
      if ('fork_id' in live) {
        const call = live.calls.find((c) => c.seq === need.seq)
        say(`    seq ${need.seq} find-slot answered live: ${JSON.stringify(call?.answer)}, source ${call?.source}`)
        say(`      ${changed(before, snapshot())}; it came from ${JSON.stringify(reached.at(-1)?.caller ?? null)}`)
        current = live
        continue
      }

      say(`    seq ${need.seq} find-slot, choice live refused: ${live.code}: ${live.message}`)
    }

    const choice = need.choices.includes('live') && !need.effects.includes('irreversible') && need.function_id !== 'calendar::find-slot' ? 'live' : 'typed'
    const value = choice === 'typed' ? { value: TYPED[need.function_id]?.(need) ?? { typed: true } } : {}
    say(`    seq ${need.seq} ${need.function_id} (effects ${JSON.stringify(need.effects)}, choices ${need.choices.join(', ')}), answering ${choice}`)
    current = await a.call<Fork>('rewind::answer', { fork_id: current.fork_id, choice, ...value })
  }

  return current
}

type ToolCall = { tool_call: { name: string; args: { attendee: string; day: string; duration: number } } }

async function forkOntoAnotherDay(detail: RunDetail): Promise<void> {
  const model = detail.calls.find((c) => c.function_id === 'model::complete' && 'value' in c.answer && JSON.stringify(c.answer.value).includes('find-slot'))
  if (!model || !('value' in model.answer)) {
    say('  no model answer that asks for find-slot')
    return
  }

  const picked = model.answer.value as ToolCall
  const day = new Date(`${picked.tool_call.args.day}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() + 7)
  const args = { ...picked.tool_call.args, day: day.toISOString().slice(0, 10) }
  say(`  forking ${detail.run.run_id} at seq ${model.seq}: find-slot for ${args.day} instead of ${picked.tool_call.args.day}`)
  const before = snapshot()
  const fork = await a.call<Fork>('rewind::fork', {
    run_id: detail.run.run_id,
    at_seq: model.seq,
    answer: { value: { tool_call: { ...picked.tool_call, args } } },
    source: 'edited',
  })
  say(`    ${fork.fork_id}: ${describe(fork.outcome)}`)
  const finished = await answerPauses(fork)
  say(`    ${finished.fork_id} finished: ${describe(finished.outcome)}`)
  say(`    calls ${sources(finished)}`)
  say(`    over the whole fork: ${changed(before, snapshot())}`)
}

async function ownerListed(): Promise<boolean> {
  return (await functions(a)).some((f) => inDefault(f) && f.function_id === 'calendar::find-slot')
}

async function replayWithoutOwner(detail: RunDetail): Promise<void> {
  const pid = workerPid(layout.ownerSetup, layout.owner)
  if (!pid) {
    say(`  no ${layout.owner} process found`)
    return
  }

  process.kill(pid, 'SIGKILL')
  const killed = Date.now()
  while (await ownerListed()) {
    await sleep(20)
  }

  say(`  killed ${layout.owner} (pid ${pid}); calendar::find-slot left engine A's list after ${Date.now() - killed} ms`)
  await replay('replay while it is gone', detail)
  while (!(await ownerListed())) {
    await sleep(100)
  }

  say(`  calendar::find-slot is back on engine A ${Date.now() - killed} ms after the kill`)
  await sleep(1_000)
  await replay('replay once it is back', detail)
}

say(`Replay and forks on ${setup}, ${new Date().toISOString()}`)
try {
  await observeTools()
  const { withTools, withoutTools } = await pickRuns()
  say('1. Replay')
  if (withTools) {
    await replay('a run with its tool calls recorded', withTools)
  }

  if (withoutTools && setup === 'split') {
    await replay('a run recorded before the bridged tools were on the record list', withoutTools)
  }

  say('2. Fork onto another day, so find-slot gets an input the recording lacks')
  if (withTools) {
    await forkOntoAnotherDay(withTools)
  }

  say(`3. Replay without a stub for calendar::find-slot: kill ${layout.owner} first`)
  if (withTools) {
    await replayWithoutOwner(withTools)
  }
} finally {
  await a.shutdown()
  if (tools !== a) {
    await tools.shutdown()
  }
}

mkdirSync(RESULTS_DIR, { recursive: true })
writeFileSync(path.join(RESULTS_DIR, `replay-${setup}.txt`), `${out.join('\n')}\n`)
process.exit(0)
