/**
 * Pausing a durable run, against the plain way of awaiting a promise in the handler. Each part
 * runs both: probe::approve and probe::nap in the pauser role, with the journal, and the same
 * steps in the rival role, without one. 1: the worker dies while a run waits for approval.
 * 2: the journal dies while a run sleeps 10 s. 3: a wait with a short timeout gets no value, and
 * then a late one, and 40 waits race their value against their timeout. 4: the value arrives
 * before the run reaches its wait. 5: 200 runs wait at once, then half are approved, the worker
 * dies, and the other half are approved. The many runs of 3 and 5 stay out of the timeline.
 *
 * Run from this folder after `npm install` here and in workers/journal:
 *   III_BIN=~/.local/bin/iii npx tsx q3Pause.ts > results/q3Pause.txt
 * It writes the numbers to results/q3Pause.json.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { brief, connect, HERE, JOURNAL_WORKER, log, type Role, sleep, startProbe, startRole, timeline, waitForFunctions } from './lib.js'

type Pending = { step: number; kind: string; name?: string; wake_at_ms?: number; timeout_at_ms?: number }
type Parked = { pending: true; workflow_id: string; waiting_for?: Pending }
type Decision = { timed_out: boolean; value?: unknown }
type Approved = { label: string; sent: string | null; decision: Decision }
type Detail = {
  status: string
  output?: Approved & { slept_ms?: number }
  executions: { epoch: number; at_ms: number }[]
  steps: { step: number; function_id: string; outcome?: { ok: boolean; value?: unknown } }[]
  values: { name: string; settled_by: string }[]
}
type Stats = { rss: number; heap_used: number; running: number; awaiting?: number }
type Resolution = { resolved: boolean; resumed: boolean; reason?: string }

const MB = 1024 * 1024
const results: Record<string, unknown> = {}

const probe = await startProbe('q3')
const journalEnv = { JOURNAL_FILE: path.join(probe.dir, 'journal.sqlite') }
const gcEnv = { NODE_OPTIONS: '--expose-gc' }
const pauserEnv = { ...gcEnv, REWIND_CAPTURE_FILE: path.join(probe.dir, 'captures.jsonl') }
let journal = startRole('journal', JOURNAL_WORKER, journalEnv)
const callee = startRole('callee', 'callee.ts')
let pauser = startRole('pauser', 'pauser.ts', pauserEnv, true)
let rival = startRole('rival', 'rival.ts', gcEnv)
await Promise.all([journal.waitFor(/journal ready/), callee.waitFor(/^ROLE/), pauser.waitFor(/^ROLE/), rival.waitFor(/^ROLE/)])
const caller = connect('probe-caller')
await waitForFunctions(caller, ['probe::approve', 'probe::nap', 'probe::rival-approve', 'probe::read', 'journal::resolve'])

function call<T>(functionId: string, payload: unknown, timeoutMs = 30_000): Promise<T> {
  return caller.call<unknown, T>({ function_id: functionId, payload, timeoutMs })
}

const approve = (label: string, extra: Record<string, unknown> = {}) => call<Parked | Approved>('probe::approve', { label, _workflow_id: `wf-${label}`, ...extra })
const resolve = (label: string, value: unknown) => call<Resolution>('journal::resolve', { workflow_id: `wf-${label}`, name: 'approval', value })
const detail = (label: string) => call<Detail>('journal::get', { workflow_id: `wf-${label}` })
const stats = () => call<Stats>('probe::stats', {})
const rivalStats = () => call<Stats>('probe::rival-stats', {})
const rivalResolve = (label: string, value: unknown) => call<{ resolved: boolean }>('probe::rival-resolve', { label, value })

/** How many times the callee sent for a label, and how many repeats of a key it dropped. */
function sendsFor(label: string): { sends: number; repeats: number } {
  const sends = callee.lines.filter((line) => new RegExp(`^STEP send ${label} `).test(line)).length
  const repeats = callee.lines.filter((line) => new RegExp(`^STEP send-repeat ${label} `).test(line)).length
  return { sends, repeats }
}

async function settledDetail(label: string, timeoutMs = 30_000): Promise<Detail> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // The journal may be restarting, which the probe waits out.
    const found = await detail(label).catch(() => undefined)
    if (found && (found.status === 'done' || found.status === 'failed' || Date.now() > deadline)) {
      return found
    }

    await sleep(50)
  }
}

async function restart(role: Role, file: string, env: Record<string, string>, preload: boolean): Promise<Role> {
  const next = startRole(role.name, file, env, preload)
  await next.waitFor(/^ROLE|journal ready/)
  return next
}

async function until(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) {
      return true
    }

    await sleep(50)
  }

  return false
}

log('--- 1. the worker dies while a run waits for approval')
{
  const parked = (await approve('k1')) as Parked
  log('durable: probe::approve returned', parked)
  pauser.kill('SIGKILL')
  pauser = await restart(pauser, 'pauser.ts', pauserEnv, true)
  await waitForFunctions(caller, ['probe::approve'])
  const approvedAt = Date.now()
  const resolution = await resolve('k1', { approved: true })
  const done = await settledDetail('k1')
  const resumeMs = done.executions.at(-1)!.at_ms - approvedAt
  log(`CHECK durable: resolve ${JSON.stringify(resolution)}, run ${done.status}, ${done.executions.length} executions, output`, done.output, 'sends', sendsFor('k1'), `second execution began ${resumeMs} ms after the resolve`)
  results.kill_durable = { status: done.status, executions: done.executions.length, ...sendsFor('k1'), resume_ms: resumeMs }

  const rivalCall = call<Approved>('probe::rival-approve', { label: 'rk1' }).then(
    (value) => ({ value }),
    (error) => ({ error: brief(error) }),
  )
  await until(async () => (await rivalStats()).awaiting === 1)
  rival.kill('SIGKILL')
  const ended = await rivalCall
  rival = await restart(rival, 'rival.ts', gcEnv, false)
  await waitForFunctions(caller, ['probe::rival-resolve'])
  const late = await rivalResolve('rk1', { approved: true })
  log('CHECK rival: the caller got', ended, 'resolve after the restart', late, 'sends', sendsFor('rk1'))
  results.kill_rival = { caller: ended, resolved: late.resolved, ...sendsFor('rk1') }
}

log('--- 2. the journal dies while a run sleeps 10 s')
{
  const parked = (await call<Parked>('probe::nap', { label: 'n1', ms: 10_000, _workflow_id: 'wf-n1' })) as Parked
  const wakeAt = parked.waiting_for!.wake_at_ms!
  log('durable: probe::nap returned', parked)
  await sleep(3_000)
  journal.kill('SIGKILL')
  await sleep(2_000)
  journal = await restart(journal, JOURNAL_WORKER, journalEnv, false)
  await waitForFunctions(caller, ['journal::get', 'journal::resolve'])
  const done = await settledDetail('n1', 30_000)
  const late = done.executions.at(-1)!.at_ms - wakeAt
  log(`CHECK durable: ${done.status}, ${done.executions.length} executions, output`, done.output, `the second execution began ${late} ms after the wake time`)
  results.sleep_durable = { status: done.status, executions: done.executions.length, slept_ms: done.output?.slept_ms, late_ms: late }

  const napping = call('probe::rival-nap', { label: 'rn1', ms: 10_000 }).then(
    (value) => ({ value }),
    (error) => ({ error: brief(error) }),
  )
  await sleep(3_000)
  rival.kill('SIGKILL')
  const ended = await napping
  rival = await restart(rival, 'rival.ts', gcEnv, false)
  log('CHECK rival: the worker holding the timer died 3 s in, and the caller got', ended)
  results.sleep_rival = { caller: ended }
}

log('--- 3. a short timeout with no value, then a late value')
{
  await approve('t1', { timeout_ms: 2_000 })
  const done = await settledDetail('t1', 10_000)
  const late = await resolve('t1', { approved: true })
  log('CHECK durable: run', done.status, 'output', done.output, 'late resolve', late, 'sends', sendsFor('t1'))
  results.timeout_durable = { decision: done.output?.decision, late, ...sendsFor('t1') }

  const rivalRun = await call<Approved>('probe::rival-approve', { label: 'rt1', timeout_ms: 2_000 })
  const rivalLate = await rivalResolve('rt1', { approved: true })
  log('CHECK rival: run', rivalRun, 'late resolve', rivalLate, 'sends', sendsFor('rt1'))
  results.timeout_rival = { decision: rivalRun.decision, late: rivalLate, ...sendsFor('rt1') }

  // Each resolve lands somewhere from 150 ms before the timeout to 150 ms after it.
  timeline.skip = /race\d+/
  const labels = Array.from({ length: 40 }, (_, i) => `race${i}`)
  const parkedAt = new Map<string, number>()
  await Promise.all(labels.map(async (label) => {
    await approve(label, { timeout_ms: 1_000 })
    parkedAt.set(label, Date.now())
  }))
  const resolutions = await Promise.all(labels.map(async (label, i) => {
    const offset = -150 + (300 * i) / (labels.length - 1)
    await sleep(Math.max(0, parkedAt.get(label)! + 1_000 + offset - Date.now()))
    return resolve(label, { approved: true })
  }))
  const outcomes = await Promise.all(labels.map((label) => settledDetail(label, 10_000)))
  const agree = labels.filter((label, i) => resolutions[i].resolved === (outcomes[i].output?.decision.timed_out === false)).length
  const won = resolutions.filter((resolution) => resolution.resolved).length
  const both = outcomes.filter((outcome) => outcome.values.length !== 1).length
  const sent = labels.reduce((total, label) => total + sendsFor(label).sends, 0)
  log(`CHECK race: ${won} of 40 values won and ${40 - won} timeouts won; the resolver's answer matched what the run got in ${agree} of 40; runs with other than one recorded value: ${both}; sends ${sent}`)
  results.race = { runs: 40, values_won: won, timeouts_won: 40 - won, agree, other_than_one_value: both, sends: sent }
}

log('--- 4. the value arrives before the run reaches its wait')
{
  const running = approve('e1', { think_ms: 1_500 })
  await sleep(300)
  const early = await resolve('e1', { approved: true })
  const returned = await running
  const done = await detail('e1')
  log('CHECK durable: early resolve', early, 'the call returned', returned, `${done.executions.length} executions`, 'sends', sendsFor('e1'))
  results.early_durable = { early, parked: 'pending' in returned, executions: done.executions.length, ...sendsFor('e1') }

  const rivalRunning = call<Approved>('probe::rival-approve', { label: 're1', think_ms: 1_500, timeout_ms: 5_000 })
  await sleep(300)
  const rivalEarly = await rivalResolve('re1', { approved: true })
  const rivalReturned = await rivalRunning
  log('CHECK rival: early resolve', rivalEarly, 'the call returned', rivalReturned, 'sends', sendsFor('re1'))
  results.early_rival = { early: rivalEarly, decision: rivalReturned.decision, ...sendsFor('re1') }
}

log('--- 5. 200 runs wait at once')
{
  timeline.skip = /\br?m\d+\b/
  const labels = Array.from({ length: 200 }, (_, i) => `m${i}`)
  const before = await stats()
  let open = 0
  const began = Date.now()
  const replies = await Promise.all(labels.map(async (label) => {
    open += 1
    try {
      return await approve(label, { think_ms: 20 })
    } finally {
      open -= 1
    }
  }))
  const parkMs = Date.now() - began
  const waiting = await stats()
  const listed = await call<unknown[]>('journal::list', { status: 'waiting' })
  log(`durable: 200 parked in ${parkMs} ms, ${replies.filter((reply) => 'pending' in reply).length} returned pending, ${listed.length} waiting in the journal, ${open} calls still open`)
  log('durable: pauser before', before, 'with 200 waiting', waiting)

  const first = labels.slice(0, 100)
  const second = labels.slice(100)
  const firstResolutions = await Promise.all(first.map((label) => resolve(label, { approved: true })))
  await Promise.all(first.map((label) => settledDetail(label)))
  pauser.kill('SIGKILL')
  pauser = await restart(pauser, 'pauser.ts', pauserEnv, true)
  await waitForFunctions(caller, ['probe::approve'])
  const secondResolutions = await Promise.all(second.map((label) => resolve(label, { approved: true })))
  const finished = await Promise.all(labels.map((label) => settledDetail(label, 60_000)))
  const once = labels.filter((label) => sendsFor(label).sends === 1).length
  const repeats = labels.reduce((total, label) => total + sendsFor(label).repeats, 0)
  const resolved = [...firstResolutions, ...secondResolutions].filter((resolution) => resolution.resolved).length
  log(`CHECK durable: ${resolved} of 200 resolves took, ${finished.filter((d) => d.status === 'done').length} of 200 done, ${once} sent exactly once, ${repeats} repeats dropped`)
  results.many_durable = {
    park_ms: parkMs,
    open_calls_while_waiting: open,
    running_while_waiting: waiting.running,
    heap_mb: [before.heap_used / MB, waiting.heap_used / MB],
    rss_mb: [before.rss / MB, waiting.rss / MB],
    resolved,
    done: finished.filter((d) => d.status === 'done').length,
    sent_once: once,
    repeats,
  }

  const rivalBefore = await rivalStats()
  let rivalOpen = 0
  const rivalCalls = labels.map((label) =>
    (async () => {
      rivalOpen += 1
      try {
        return { value: await caller.call({ function_id: 'probe::rival-approve', payload: { label: `r${label}`, think_ms: 20 } }) }
      } catch (error) {
        return { error: brief(error) as { code?: string } }
      } finally {
        rivalOpen -= 1
      }
    })(),
  )
  await until(async () => (await rivalStats()).awaiting === 200, 30_000)
  const rivalWaiting = await rivalStats()
  const rivalOpenWhileWaiting = rivalOpen
  log(`rival: 200 awaiting, ${rivalOpen} calls still open`)
  log('rival: before', rivalBefore, 'with 200 waiting', rivalWaiting)
  // The SDK's default call timeout is 30 s, so every caller gives up while its handler keeps waiting.
  await sleep(31_000)
  const stillWaiting = await rivalStats()
  const firstRival = await Promise.all(first.map((label) => rivalResolve(`r${label}`, { approved: true })))
  await sleep(1_000)
  rival.kill('SIGKILL')
  rival = await restart(rival, 'rival.ts', gcEnv, false)
  await waitForFunctions(caller, ['probe::rival-resolve'])
  const secondRival = await Promise.all(second.map((label) => rivalResolve(`r${label}`, { approved: true })))
  const ended = await Promise.all(rivalCalls)
  const timedOut = ended.filter((outcome) => 'error' in outcome && outcome.error?.code === 'TIMEOUT').length
  const sentOnce = labels.filter((label) => sendsFor(`r${label}`).sends === 1).length
  log(`CHECK rival: ${timedOut} of 200 callers timed out after 30 s while ${stillWaiting.running} handlers still waited; ${firstRival.filter((r) => r.resolved).length} of the first 100 resolves found their run and ${secondRival.filter((r) => r.resolved).length} of the 100 after the kill did; ${sentOnce} runs sent, none to a caller that was still there`)
  results.many_rival = {
    open_calls_while_waiting: rivalOpenWhileWaiting,
    running_while_waiting: rivalWaiting.running,
    heap_mb: [rivalBefore.heap_used / MB, rivalWaiting.heap_used / MB],
    rss_mb: [rivalBefore.rss / MB, rivalWaiting.rss / MB],
    callers_timed_out: timedOut,
    resolved_before_kill: firstRival.filter((r) => r.resolved).length,
    resolved_after_kill: secondRival.filter((r) => r.resolved).length,
    sent_once: sentOnce,
  }
}

writeFileSync(path.join(HERE, 'results', 'q3Pause.json'), `${JSON.stringify(results, null, 2)}\n`)
await caller.shutdown()
for (const role of [pauser, rival, callee, journal]) {
  await role.stop('SIGKILL')
}

await probe.engine.stop()
process.exit(0)
