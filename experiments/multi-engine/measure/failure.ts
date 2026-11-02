/**
 * Question 6: what the agent's side sees when a worker dies mid-call, and
 * whether Rewind's lost-work detection and recovery still work.
 *
 * For each worker it kills (tools, and on `split` also the bridge):
 *   1. three direct find-slot calls from engine A, each killed 200 ms in: the
 *      error, how long after the kill it came, and when calls worked again;
 *   2. one email::send killed 100 ms in, and whether the invite went out anyway;
 *   3. a burst of agent runs killed 1.5 s in, then rewind::lost and rewind::recover.
 *
 * Run from experiments/multi-engine with the setup up:
 *   npx tsx measure/failure.ts single | split
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { ENGINE_A, ENGINE_B, OUTBOX_A, OUTBOX_SINGLE, RESULTS_DIR, type Engine, type Setup, connect, lines, sleep, workerPid } from '../lib/engines.js'

type Victim = { name: string; setup: Setup }
type Layout = { victims: Victim[]; outbox: string; toolsEngine: string }

const LAYOUT: Record<string, Layout> = {
  single: { victims: [{ name: 'tools', setup: 'single' }], outbox: OUTBOX_SINGLE, toolsEngine: ENGINE_A },
  split: {
    victims: [
      { name: 'tools', setup: 'engine-b' },
      { name: 'bridge', setup: 'engine-a' },
    ],
    outbox: OUTBOX_A,
    toolsEngine: ENGINE_B,
  },
}

const setup = process.argv[2] ?? ''
const layout = LAYOUT[setup]
if (!layout) {
  console.error('usage: npx tsx measure/failure.ts single|split')
  process.exit(2)
}

const out: string[] = []
function say(line = ''): void {
  console.log(line)
  out.push(line)
}

const a = connect(ENGINE_A, 'failure-probe')
const tools: Engine = layout.toolsEngine === ENGINE_A ? a : connect(layout.toolsEngine, 'failure-probe')
type Envelope = { function_id: string; status: string; input?: { subject?: string; attendee?: string }; error?: unknown; duration_ms: number }
const completions: Envelope[] = []

async function observeTools(): Promise<void> {
  tools.worker.registerFunction('iii::failure-probe::completed', async (envelope: Envelope) => {
    completions.push(envelope)
    return null
  })
  await sleep(500)
  for (const functionId of ['calendar::find-slot', 'email::send']) {
    await tools.worker.observe({ function_id: functionId, on: 'complete', capture: ['input', 'output', 'error'] }, 'iii::failure-probe::completed').ready()
  }
}

function errorOf(error: unknown): { code?: string; message?: string } {
  const { code, message } = error as { code?: string; message?: string }
  return { code, message }
}

function kill(victim: Victim): number {
  const pid = workerPid(victim.setup, victim.name)
  if (!pid) {
    throw new Error(`no ${victim.name} process for ${victim.setup}`)
  }

  process.kill(pid, 'SIGKILL')
  return performance.now()
}

/** Calls find-slot through engine A until one succeeds, and returns when that was. */
async function backAt(): Promise<number> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const ok = await a
      .call('calendar::find-slot', { attendee: `back-${attempt}@example.com`, day: '2026-11-10', duration: 30 }, 5_000)
      .then(() => true)
      .catch(() => false)
    if (ok) {
      return performance.now()
    }

    await sleep(50)
  }

  return Number.NaN
}

async function directCalls(victim: Victim): Promise<void> {
  say(`  direct calendar::find-slot from engine A, ${victim.name} killed 200 ms in`)
  for (let round = 1; round <= 3; round++) {
    const sent = performance.now()
    const pending = a.call('calendar::find-slot', { attendee: `kill-${victim.name}-${round}@example.com`, day: '2026-11-10', duration: 30 }, 30_000)
    await sleep(200)
    const killedAt = kill(victim)
    const result = await pending.then((value) => ({ value })).catch((error) => ({ error: errorOf(error) }))
    const answeredAt = performance.now()
    const failedFast = await a
      .call('calendar::find-slot', { attendee: `right-after-${round}@example.com`, day: '2026-11-10', duration: 30 }, 5_000)
      .then((value) => ({ value }))
      .catch((error) => ({ error: errorOf(error) }))
    const back = await backAt()
    say(`    round ${round}: caller got ${JSON.stringify(result)} ${(answeredAt - killedAt).toFixed(1)} ms after the kill (${(answeredAt - sent).toFixed(0)} ms after it sent)`)
    say(`      a call made right after got ${JSON.stringify(failedFast)}`)
    say(`      calls through engine A worked again ${(back - killedAt).toFixed(0)} ms after the kill`)
    await sleep(1_000)
  }
}

async function sendKilled(victim: Victim): Promise<void> {
  const subject = `multi-engine kill ${victim.name} ${Date.now()}`
  const before = completions.length
  const pending = a.call('email::send', { to: 'probe@example.com', subject, start: '2026-11-10T14:00:00-06:00' }, 30_000)
  await sleep(100)
  const killedAt = kill(victim)
  const result = await pending.then((value) => ({ value })).catch((error) => ({ error: errorOf(error) }))
  say(`  email::send killed 100 ms in: caller got ${JSON.stringify(result)} ${(performance.now() - killedAt).toFixed(1)} ms after the kill`)
  await sleep(4_000)
  const sent = lines(layout.outbox).filter((line) => line.includes(subject))
  const seen = completions.slice(before).filter((e) => e.input?.subject === subject)
  say(`    outbox lines with this subject 4 s later: ${sent.length}${sent[0] ? ` (${sent[0]})` : ''}`)
  say(`    completions the tools' engine reported for it: ${seen.map((e) => `${e.status} after ${e.duration_ms.toFixed(0)} ms`).join(', ') || 'none'}`)
  await backAt()
}

type Answer = { value: unknown } | { error: { code?: string; message: string } }
type Call = { seq: number; function_id: string; answer: Answer; source: string; input: unknown }
type Need = { seq: number; function_id: string; effects: string[]; choices: string[]; input: unknown }
type Outcome = { state: 'done'; output: unknown } | { state: 'crashed'; error: unknown } | { state: 'paused'; need: Need }
type Fork = { fork_id: string; mode: string; calls: Call[]; outcome: Outcome }
type LostRun = { run_id: string; lost_at: number; output?: { reply?: string }; error?: { message?: string } }
type WorkerChange = { at_ms: number; worker: string; worker_id: string; event: string }
type RunDetail = { calls: Call[]; worker_changes: WorkerChange[] }

function describe(outcome: Outcome): string {
  if (outcome.state === 'paused') {
    return `paused at seq ${outcome.need.seq} ${outcome.need.function_id}, effects ${JSON.stringify(outcome.need.effects)}, choices ${outcome.need.choices.join(', ')}`
  }

  return `${outcome.state} ${JSON.stringify('output' in outcome ? outcome.output : outcome.error)}`
}

/** A lost run whose model asked for a well-formed slot, so its recovery has a live slot lookup to make. */
async function pickLost(lost: LostRun[]): Promise<LostRun> {
  for (const run of lost) {
    const detail = await a.call<RunDetail>('rewind::run', { run_id: run.run_id })
    const answer = detail.calls.find((c) => c.function_id === 'model::complete')?.answer
    const args = answer && 'value' in answer ? (answer.value as { tool_call?: { args?: { duration?: unknown } } }).tool_call?.args : undefined
    if (typeof args === 'object' && typeof args.duration === 'number') {
      return run
    }
  }

  return lost[0]
}

async function recover(run: LostRun): Promise<void> {
  const before = lines(layout.outbox).length
  const completionsBefore = completions.length
  let fork = await a.call<Fork>('rewind::recover', { run_id: run.run_id })
  say(`    rewind::recover ${run.run_id} -> ${fork.fork_id} (${fork.mode}): ${describe(fork.outcome)}`)
  for (let pause = 0; pause < 10 && fork.outcome.state === 'paused'; pause++) {
    const need = fork.outcome.need
    const choice = need.choices.includes('live') && !need.effects.includes('irreversible') ? 'live' : 'typed'
    const value = choice === 'typed' ? { value: { status: 'accepted', id: 'msg_multi_engine' } } : {}
    fork = await a.call<Fork>('rewind::answer', { fork_id: fork.fork_id, choice, ...value })
    const answered = fork.calls.find((c) => c.seq === need.seq)
    say(`      seq ${need.seq} ${need.function_id} answered ${choice}: ${JSON.stringify(answered?.answer).slice(0, 160)}; now ${describe(fork.outcome)}`)
  }

  say(`    calls ${fork.calls.map((c) => `${c.seq}:${c.function_id}=${c.source}`).join(' ')}`)
  const reached = completions.slice(completionsBefore).map((e) => `${e.function_id} ${e.status}`)
  say(`    the tools' engine ran ${reached.length} call(s) during the recovery: ${reached.join(', ') || 'none'}; outbox ${before} -> ${lines(layout.outbox).length}`)
}

async function burstKilled(victim: Victim): Promise<void> {
  const lostBefore = new Set((await a.call<LostRun[]>('rewind::lost')).map((r) => r.run_id))
  const burst = a.call<Record<string, number>>('traffic::burst', { count: 16, interval_ms: 120 }, 180_000)
  await sleep(1_500)
  kill(victim)
  const killedAtMs = Date.now()
  say(`  burst of 16 runs, ${victim.name} killed 1.5 s in: ${JSON.stringify(await burst)}`)
  await backAt()
  let lost: LostRun[] = []
  for (let attempt = 0; attempt < 40 && lost.length === 0; attempt++) {
    await sleep(250)
    lost = (await a.call<LostRun[]>('rewind::lost')).filter((r) => !lostBefore.has(r.run_id))
  }

  say(`    rewind::lost lists ${lost.length} new run(s)`)
  for (const run of lost.slice(0, 4)) {
    say(`      ${run.run_id} lost at seq ${run.lost_at}: ${(run.output?.reply ?? run.error?.message ?? '').slice(0, 200)}`)
  }

  if (lost.length === 0) {
    return
  }

  const target = await pickLost(lost)
  await sleep(3_000)
  const changes = (await a.call<RunDetail>('rewind::run', { run_id: target.run_id })).worker_changes
  const near = changes.filter((c) => Math.abs(c.at_ms - killedAtMs) < 10_000)
  say(`    worker changes Rewind A has around the kill: ${near.map((c) => `${c.event} ${c.worker}`).join(', ') || 'none'}`)
  await recover(target)
}

say(`Failure across the boundary on ${setup}, ${new Date().toISOString()}`)
try {
  await observeTools()
  for (const victim of layout.victims) {
    say(`Kill ${victim.name} (${victim.setup})`)
    await directCalls(victim)
    await sendKilled(victim)
    await burstKilled(victim)
  }
} finally {
  await a.shutdown()
  if (tools !== a) {
    await tools.shutdown()
  }
}

mkdirSync(RESULTS_DIR, { recursive: true })
writeFileSync(path.join(RESULTS_DIR, `failure-${setup}.txt`), `${out.join('\n')}\n`)
process.exit(0)
