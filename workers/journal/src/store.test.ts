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

  it('pauses a workflow whose lost step writes, before any of its code runs again', () => {
    const journal = fresh()
    const epoch = epochOf(journal.begin(start()))
    journal.intent('wf-1', epoch, 0, 'billing::charge', 'h0', WRITES)
    const paused = journal.begin(start())
    assert.deepEqual(paused, { status: 'paused', pause: { step: 0, function_id: 'billing::charge', reason: 'lost' } })
    assert.deepEqual(journal.answer('wf-1', 0, { again: true }), { answered: true })
    const resumed = journal.begin(start())
    assert.ok('status' in resumed && resumed.status === 'running')
    assert.equal(resumed.steps[0].resume, 'again')
  })

  it('takes the outcome a person gives for a lost step', () => {
    const journal = fresh()
    const epoch = epochOf(journal.begin(start()))
    journal.intent('wf-1', epoch, 0, 'billing::charge', 'h0', WRITES)
    journal.begin(start())
    journal.answer('wf-1', 0, { outcome: { ok: true, value: { charged: true } } })
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
