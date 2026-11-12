/**
 * Tests for the journal's store and its resume rules. They need no engine: each test opens a
 * fresh SQLite file in a temporary folder. Run them with `npm test` in workers/journal.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { resumeOf } from './resume.js'
import { type Begin, Journal } from './store.js'

const scratch = mkdtempSync(path.join(tmpdir(), 'journal-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let opened = 0
function fresh(): Journal {
  opened += 1
  return new Journal(path.join(scratch, `journal-${opened}.sqlite`))
}

const READS = { effects: ['read-only'], takesKey: false }
const MODEL = { effects: ['external'], takesKey: false }
const SEND = { effects: ['irreversible'], takesKey: true }
const WRITES = { effects: ['writes'], takesKey: false }

function start(overrides: Partial<Begin> = {}): Begin {
  return { workflow_id: 'wf-1', function_id: 'agent::run', input: { request: 'x' }, input_hash: 'h-in', worker_id: 'w-1', invocation_id: 'i-1', started_by: 'traffic', ...overrides }
}

function epochOf(claim: ReturnType<Journal['begin']>): number {
  assert.ok('status' in claim && claim.status === 'running', `expected a running claim, got ${JSON.stringify(claim)}`)
  return claim.epoch
}

describe('the journal', () => {
  it('gives each execution of a workflow the next epoch and fences writes from the one before', () => {
    const journal = fresh()
    const first = epochOf(journal.begin(start()))
    journal.intent('wf-1', first, 0, 'clock::now', 'h0', READS)
    const second = epochOf(journal.begin(start({ worker_id: 'w-2' })))
    assert.equal(second, first + 1)
    assert.equal((journal.result('wf-1', first, 0, { ok: true, value: 1 }) as { rejected: string }).rejected, 'FENCED')
    assert.equal((journal.intent('wf-1', first, 1, 'model::complete', 'h1', MODEL) as { rejected: string }).rejected, 'FENCED')
    assert.equal(journal.detail('wf-1')?.fenced.length, 2)
  })

  it('returns a finished step to a later execution and marks one that was in flight by what its callee declares', () => {
    const journal = fresh()
    const epoch = epochOf(journal.begin(start()))
    journal.intent('wf-1', epoch, 0, 'clock::now', 'h0', READS)
    journal.result('wf-1', epoch, 0, { ok: true, value: { now: 'today' } })
    journal.intent('wf-1', epoch, 1, 'model::complete', 'h1', MODEL)
    const again = journal.begin(start())
    assert.ok('status' in again && again.status === 'running')
    assert.deepEqual(again.steps[0].outcome, { ok: true, value: { now: 'today' } })
    assert.equal(again.steps[1].resume, 'again')
  })

  it('keeps an irreversible step on the same idempotency key in every execution', () => {
    const journal = fresh()
    const first = epochOf(journal.begin(start()))
    const sent = journal.intent('wf-1', first, 4, 'email::send', 'h4', SEND)
    assert.deepEqual(sent, { idempotency_key: 'wf-1:4' })
    const second = journal.begin(start())
    assert.ok('status' in second && second.status === 'running')
    assert.equal(second.steps[0].resume, 'keyed')
    assert.deepEqual(journal.intent('wf-1', second.epoch, 4, 'email::send', 'h4', SEND), { idempotency_key: 'wf-1:4' })
    assert.equal(journal.detail('wf-1')?.attempts.length, 2)
  })

  it('leaves a lost step that writes pending for a person, before any of its code runs again, and sends it again when resolved with execute', () => {
    const journal = fresh()
    const epoch = epochOf(journal.begin(start()))
    journal.intent('wf-1', epoch, 0, 'billing::charge', 'h0', WRITES)
    const waiting = journal.begin(start())
    assert.ok('status' in waiting && waiting.status === 'waiting')
    assert.deepEqual({ ...waiting.pending, since_ms: 0 }, { step: 0, function_id: 'billing::charge', kind: 'lost', since_ms: 0 })
    assert.equal(journal.get('wf-1')?.status, 'waiting')
    assert.deepEqual(journal.begin(start()), waiting)
    assert.deepEqual(journal.resolve({ workflow_id: 'wf-1', step: 0, action: 'execute' }), { resolved: true, resumed: true, step: 0 })
    const resumed = journal.begin(start())
    assert.ok('status' in resumed && resumed.status === 'running')
    assert.equal(resumed.steps[0].resume, 'again')
  })

  it('takes the result a person gives for a lost step, and refuses a second resolve', () => {
    const journal = fresh()
    const epoch = epochOf(journal.begin(start()))
    journal.intent('wf-1', epoch, 0, 'billing::charge', 'h0', WRITES)
    journal.begin(start())
    assert.equal(journal.resolve({ workflow_id: 'wf-1', step: 0, value: { charged: true } }).resolved, true)
    assert.equal(journal.resolve({ workflow_id: 'wf-1', step: 0, value: { charged: false } }).resolved, false)
    const resumed = journal.begin(start())
    assert.ok('status' in resumed && resumed.status === 'running')
    assert.deepEqual(resumed.steps[0].outcome, { ok: true, value: { charged: true } })
  })

  it('fails a workflow loudly when a step comes back with another input', () => {
    const journal = fresh()
    const epoch = epochOf(journal.begin(start()))
    journal.intent('wf-1', epoch, 0, 'model::complete', 'h0', MODEL)
    const next = epochOf(journal.begin(start()))
    const diverged = journal.intent('wf-1', next, 0, 'model::complete', 'h-other', MODEL)
    assert.equal((diverged as { rejected: string }).rejected, 'DIVERGED')
    assert.equal(journal.get('wf-1')?.status, 'failed')
    assert.equal(journal.get('wf-1')?.error?.code, 'DIVERGED')
  })

  it('refuses a workflow id used again with another input, and leaves the first run alone', () => {
    const journal = fresh()
    epochOf(journal.begin(start()))
    const reused = journal.begin(start({ input_hash: 'h-other' }))
    assert.equal((reused as { rejected: string }).rejected, 'DIVERGED')
    assert.equal(journal.get('wf-1')?.status, 'running')
  })

  it('takes a write again without a second attempt, the way the preload retries while the journal restarts', () => {
    const journal = fresh()
    const epoch = epochOf(journal.begin(start()))
    journal.intent('wf-1', epoch, 0, 'clock::now', 'h0', READS)
    journal.intent('wf-1', epoch, 0, 'clock::now', 'h0', READS)
    journal.result('wf-1', epoch, 0, { ok: true, value: 1 })
    assert.deepEqual(journal.result('wf-1', epoch, 0, { ok: true, value: 1 }), { saved: true })
    journal.finish('wf-1', epoch, { ok: true, value: 'done' })
    assert.deepEqual(journal.finish('wf-1', epoch, { ok: true, value: 'done' }), { saved: true })
    assert.equal(journal.detail('wf-1')?.attempts.length, 1)
  })

  it('returns a finished workflow as it ended, without a new epoch', () => {
    const journal = fresh()
    const epoch = epochOf(journal.begin(start()))
    journal.finish('wf-1', epoch, { ok: true, value: { status: 'booked' } })
    assert.deepEqual(journal.begin(start()), { status: 'done', output: { status: 'booked' } })
    assert.equal(journal.get('wf-1')?.epoch, epoch)
  })

  it('lists a running workflow as an orphan once its owner leaves or is released', () => {
    const journal = fresh()
    journal.begin(start({ workflow_id: 'wf-a', worker_id: 'w-1' }))
    journal.begin(start({ workflow_id: 'wf-b', worker_id: 'w-2' }))
    const ids = (live: string[]) => journal.orphans(new Set(live), 60_000).map((workflow) => workflow.workflow_id)
    assert.deepEqual(ids(['w-1', 'w-2']), [])
    assert.deepEqual(journal.release('w-1'), ['wf-a'])
    assert.deepEqual(ids(['w-1', 'w-2']), ['wf-a'])
    assert.deepEqual(ids(['w-1']), ['wf-a', 'wf-b'])
  })

  it('lists a running workflow as an orphan when nothing has written to it for the stale window', () => {
    let now = 1_000
    const journal = new Journal(path.join(scratch, 'stale.sqlite'), () => now)
    const epoch = epochOf(journal.begin(start()))
    journal.intent('wf-1', epoch, 0, 'clock::now', 'h0', READS)
    now += 59_000
    assert.deepEqual(journal.orphans(new Set(['w-1']), 60_000), [])
    now += 2_000
    assert.deepEqual(journal.orphans(new Set(['w-1']), 60_000).map((workflow) => workflow.workflow_id), ['wf-1'])
  })
})

describe('waits and sleeps', () => {
  const APPROVAL = { kind: 'wait' as const, name: 'approval', detail: { to: 'dana' }, choices: [{ label: 'Approve', value: { approved: true } }] }

  function waiting(): { journal: Journal; epoch: number; clock: { now: number } } {
    const clock = { now: 1_000 }
    opened += 1
    const journal = new Journal(path.join(scratch, `waits-${opened}.sqlite`), () => clock.now)
    const epoch = epochOf(journal.begin(start()))
    journal.intent('wf-1', epoch, 0, 'clock::now', 'h0', READS)
    journal.result('wf-1', epoch, 0, { ok: true, value: 'today' })
    return { journal, epoch, clock }
  }

  it('leaves a wait pending with what it waits for, and gives the run its value once resolved by name', () => {
    const { journal, epoch } = waiting()
    const parked = journal.park('wf-1', epoch, 1, 'durable::wait', 'h1', APPROVAL)
    assert.deepEqual(parked, {
      pending: { step: 1, function_id: 'durable::wait', kind: 'wait', since_ms: 1_000, name: 'approval', detail: { to: 'dana' }, choices: APPROVAL.choices },
    })
    const listed = journal.list('waiting')
    assert.deepEqual(listed.map((workflow) => [workflow.workflow_id, workflow.pending?.name, workflow.owner_worker_id]), [['wf-1', 'approval', null]])
    assert.deepEqual(journal.orphans(new Set(), 60_000), [])
    assert.deepEqual(journal.resolve({ workflow_id: 'wf-1', name: 'approval', value: { approved: true } }), { resolved: true, resumed: true, step: 1 })
    assert.deepEqual(journal.resolve({ workflow_id: 'wf-1', name: 'approval', value: { approved: false } }), { resolved: false, resumed: false, reason: '"approval" was already resolved' })
    assert.deepEqual(journal.orphans(new Set(), 60_000).map((workflow) => workflow.workflow_id), ['wf-1'])
    const again = journal.begin(start())
    assert.ok('status' in again && again.status === 'running')
    assert.deepEqual(again.steps[1].outcome, { ok: true, value: { timed_out: false, value: { approved: true } } })
  })

  it('keeps a value sent before the run reaches its wait, and returns it there without waiting', () => {
    const { journal, epoch } = waiting()
    assert.deepEqual(journal.resolve({ workflow_id: 'wf-1', name: 'approval', value: { approved: true } }), { resolved: true, resumed: false })
    assert.equal(journal.get('wf-1')?.status, 'running')
    assert.deepEqual(journal.park('wf-1', epoch, 1, 'durable::wait', 'h1', APPROVAL), { outcome: { ok: true, value: { timed_out: false, value: { approved: true } } } })
    assert.deepEqual(journal.park('wf-1', epoch, 2, 'durable::wait', 'h2', APPROVAL), { outcome: { ok: true, value: { timed_out: false, value: { approved: true } } } })
    assert.equal(journal.resolve({ workflow_id: 'wf-1', name: 'approval', value: { approved: false } }).resolved, false)
  })

  it('records whichever lands first when a value races a timeout', () => {
    const { journal, epoch, clock } = waiting()
    journal.park('wf-1', epoch, 1, 'durable::wait', 'h1', { kind: 'wait', name: 'approval', timeout_ms: 5_000 })
    assert.equal(journal.nextDue(), 6_000)
    clock.now = 5_999
    assert.deepEqual(journal.due(), [])
    clock.now = 6_000
    assert.deepEqual(journal.due(), ['wf-1'])
    assert.deepEqual(journal.resolve({ workflow_id: 'wf-1', name: 'approval', value: { approved: true } }), {
      resolved: false,
      resumed: false,
      reason: 'the wait for "approval" timed out first',
    })
    assert.equal(journal.nextDue(), null)
    const again = journal.begin(start())
    assert.ok('status' in again && again.status === 'running')
    assert.deepEqual(again.steps[1].outcome, { ok: true, value: { timed_out: true } })
  })

  it('ignores the timeout of a wait resolved before it', () => {
    const { journal, epoch, clock } = waiting()
    journal.park('wf-1', epoch, 1, 'durable::wait', 'h1', { kind: 'wait', name: 'approval', timeout_ms: 5_000 })
    assert.equal(journal.resolve({ workflow_id: 'wf-1', step: 1, value: 'yes' }).resolved, true)
    clock.now = 10_000
    assert.deepEqual(journal.due(), [])
    assert.deepEqual(journal.detail('wf-1')?.steps[1].outcome, { ok: true, value: { timed_out: false, value: 'yes' } })
  })

  it('wakes a sleep at its time, or at once when someone resolves it', () => {
    const { journal, epoch, clock } = waiting()
    const parked = journal.park('wf-1', epoch, 1, 'durable::sleep', 'h1', { kind: 'sleep', ms: 10_000 })
    assert.equal((parked as { pending: { wake_at_ms?: number } }).pending.wake_at_ms, 11_000)
    clock.now = 11_250
    assert.deepEqual(journal.due(), ['wf-1'])
    assert.deepEqual(journal.detail('wf-1')?.steps[1].outcome, { ok: true, value: { slept_ms: 10_250 } })
    const next = epochOf(journal.begin(start()))
    journal.park('wf-1', next, 2, 'durable::sleep', 'h2', { kind: 'sleep', ms: 60_000 })
    clock.now = 12_000
    assert.deepEqual(journal.resolve({ workflow_id: 'wf-1', step: 2 }), { resolved: true, resumed: true, step: 2 })
    assert.deepEqual(journal.detail('wf-1')?.steps[2].outcome, { ok: true, value: { slept_ms: 750 } })
  })

  it('refuses new steps while the run waits, and saves the result of a call that was already out', () => {
    const { journal, epoch } = waiting()
    journal.intent('wf-1', epoch, 1, 'model::complete', 'h1', MODEL)
    journal.park('wf-1', epoch, 2, 'durable::wait', 'h2', APPROVAL)
    assert.deepEqual(journal.result('wf-1', epoch, 1, { ok: true, value: 'answer' }), { saved: true })
    const refused = journal.intent('wf-1', epoch, 3, 'email::send', 'h3', SEND) as { rejected: string; pending?: { step: number } }
    assert.equal(refused.rejected, 'WAITING')
    assert.equal(refused.pending?.step, 2)
    assert.equal(journal.detail('wf-1')?.fenced.length, 0)
    assert.equal((journal.finish('wf-1', epoch, { ok: true, value: null }) as { rejected: string }).rejected, 'WAITING')
  })

  it('fails the run as DIVERGED when a wait comes back with another name, and refuses execute on a wait', () => {
    const { journal, epoch } = waiting()
    journal.park('wf-1', epoch, 1, 'durable::wait', 'h1', APPROVAL)
    assert.equal(journal.resolve({ workflow_id: 'wf-1', step: 1, action: 'execute' }).resolved, false)
    journal.resolve({ workflow_id: 'wf-1', step: 1, value: 1 })
    const next = epochOf(journal.begin(start()))
    const diverged = journal.park('wf-1', next, 1, 'durable::wait', 'h-other', { kind: 'wait', name: 'other' })
    assert.equal((diverged as { rejected: string }).rejected, 'DIVERGED')
    assert.equal(journal.get('wf-1')?.status, 'failed')
    assert.equal(journal.resolve({ workflow_id: 'wf-1', name: 'late', value: 1 }).resolved, false)
  })

  it('keeps pending steps and wake times across a restart of the journal', () => {
    let now = 1_000
    const file = path.join(scratch, 'restart.sqlite')
    const first = new Journal(file, () => now)
    const epoch = epochOf(first.begin(start()))
    first.park('wf-1', epoch, 0, 'durable::sleep', 'h0', { kind: 'sleep', ms: 10_000 })
    first.close()
    now = 12_000
    const second = new Journal(file, () => now)
    assert.equal(second.nextDue(), 11_000)
    assert.deepEqual(second.due(), ['wf-1'])
    assert.equal(second.get('wf-1')?.status, 'running')
  })
})

describe('resuming a step that was in flight', () => {
  it('sends a read or a model call again, keys a send that drops repeats, and pauses the rest', () => {
    assert.equal(resumeOf(READS), 'again')
    assert.equal(resumeOf({ effects: ['pure'], takesKey: false }), 'again')
    assert.equal(resumeOf(MODEL), 'again')
    assert.equal(resumeOf(SEND), 'keyed')
    assert.equal(resumeOf({ effects: ['external', 'irreversible'], takesKey: true }), 'keyed')
    assert.equal(resumeOf({ effects: ['irreversible'], takesKey: false }), 'pause')
    assert.equal(resumeOf(WRITES), 'pause')
    assert.equal(resumeOf({ effects: ['read-only', 'writes'], takesKey: false }), 'pause')
    assert.equal(resumeOf({ effects: [], takesKey: false }), 'pause')
    assert.equal(resumeOf({ effects: ['read-onyl'], takesKey: false }), 'pause')
  })
})
