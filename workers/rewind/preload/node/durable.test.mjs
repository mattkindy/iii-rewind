/**
 * Tests for durable runs in the Node preload that need no engine: durableWorker wraps a fake
 * worker whose `call` does what the engine and the journal would, in memory.
 * Run them with `node --test workers/rewind/preload/node/durable.test.mjs`.
 */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, it } from 'node:test'
import { durableWorker, inputHash } from './durable.mjs'

class InvocationError extends Error {
  constructor(init) {
    super(`${init.code}: ${init.message}`)
    this.code = init.code
    this.function_id = init.function_id
  }
}

/**
 * A worker whose journal starts from `claim` and whose callees return what `answers` says. Like
 * the SDK's, its `call` and `registerFunction` are properties of the instance, not methods.
 */
function fakeWorker({ claim = { status: 'running', epoch: 1, steps: [] }, answers = {}, reject = {}, park = (payload) => ({ pending: { step: payload.step, function_id: payload.function_id, kind: payload.park.kind } }) } = {}) {
  const sent = []
  const journal = []
  const handlers = new Map()
  const context = new AsyncLocalStorage()
  const worker = {
    currentInvocation: () => context.getStore(),
    registerFunction: (id, handler) => {
      handlers.set(id, handler)
    },
    call: async (request) => {
      if (request.function_id.startsWith('journal::')) {
        journal.push({ ...request.payload, write: request.function_id })
        if (reject[request.function_id]) {
          return reject[request.function_id]
        }

        if (request.function_id === 'journal::begin') {
          return claim
        }

        if (request.function_id === 'journal::park') {
          return park(request.payload)
        }

        return request.function_id === 'journal::intent' && request.payload.function_id === 'email::send' ? { idempotency_key: `wf:${request.payload.step}` } : { saved: true }
      }

      sent.push(request)
      const answer = answers[request.function_id]
      if (answer instanceof Error) {
        throw answer
      }

      return answer
    },
  }
  durableWorker(worker, InvocationError)
  const invoke = (id, input) => context.run({ invocation_id: 'inv-1', caller: { worker_name: 'traffic' } }, () => handlers.get(id)(input))
  return { worker, sent, journal, invoke }
}

async function booking(worker) {
  const { now } = await worker.call({ function_id: 'clock::now', payload: {} })
  const answer = await worker.call({ function_id: 'model::complete', payload: { today: now } })
  const sent = await worker.call({ function_id: 'email::send', payload: { to: answer.to } })
  return { sent: sent.id }
}

const ANSWERS = { 'clock::now': { now: 'today' }, 'model::complete': { to: 'dana' }, 'email::send': { id: 'msg-1' } }

describe('durable runs in the preload', () => {
  it('writes each step before and after its call, in the order the code made them, and keys an irreversible one', async () => {
    const { worker, sent, journal, invoke } = fakeWorker({ answers: ANSWERS })
    worker.registerFunction('agent::run', (input) => booking(worker), { metadata: { durable: true } })
    assert.deepEqual(await invoke('agent::run', { request: 'x', _workflow_id: 'wf' }), { sent: 'msg-1' })
    assert.deepEqual(
      journal.map((entry) => `${entry.write.slice('journal::'.length)}${entry.step ?? ''}`),
      ['begin', 'intent0', 'result0', 'intent1', 'result1', 'intent2', 'result2', 'finish'],
    )
    assert.equal(journal[0].workflow_id, 'wf')
    assert.equal(journal[0].started_by, 'traffic')
    assert.deepEqual(journal[0].input, { request: 'x' })
    assert.deepEqual(sent.at(-1).metadata, { idempotency_key: 'wf:2' })
  })

  it('returns finished steps from the journal without calling, and sends the one that was in flight again', async () => {
    const steps = [
      { step: 0, function_id: 'clock::now', input_hash: inputHash({}), outcome: { ok: true, value: { now: 'yesterday' } } },
      { step: 1, function_id: 'model::complete', input_hash: inputHash({ today: 'yesterday' }), outcome: { ok: true, value: { to: 'priya' } } },
      { step: 2, function_id: 'email::send', input_hash: inputHash({ to: 'priya' }), resume: 'keyed', idempotency_key: 'wf:2' },
    ]
    const { worker, sent, invoke } = fakeWorker({ claim: { status: 'running', epoch: 2, steps }, answers: ANSWERS })
    worker.registerFunction('agent::run', () => booking(worker), { metadata: { durable: true } })
    await invoke('agent::run', { request: 'x', _workflow_id: 'wf' })
    assert.deepEqual(sent.map((request) => request.function_id), ['email::send'])
    assert.deepEqual(sent[0].payload, { to: 'priya' })
  })

  it('gives the code a saved error with the message it had the first time', async () => {
    const steps = [{ step: 0, function_id: 'clock::now', input_hash: inputHash({}), outcome: { ok: false, error: { code: 'TIMEOUT', message: 'invocation timed out after 30000ms' } } }]
    const { worker, invoke } = fakeWorker({ claim: { status: 'running', epoch: 2, steps } })
    worker.registerFunction(
      'agent::run',
      async () => worker.call({ function_id: 'clock::now', payload: {} }).catch((error) => ({ caught: error.message, code: error.code })),
      { metadata: { durable: true } },
    )
    assert.deepEqual(await invoke('agent::run', { request: 'x' }), { caught: 'TIMEOUT: invocation timed out after 30000ms', code: 'TIMEOUT' })
  })

  it('fails the run as DIVERGED when a saved step comes back with another input', async () => {
    const steps = [{ step: 0, function_id: 'clock::now', input_hash: inputHash({ zone: 'UTC' }), outcome: { ok: true, value: { now: 'today' } } }]
    const { worker, journal, invoke } = fakeWorker({ claim: { status: 'running', epoch: 2, steps }, answers: ANSWERS })
    worker.registerFunction('agent::run', () => booking(worker), { metadata: { durable: true } })
    await assert.rejects(invoke('agent::run', { request: 'x' }), /DIVERGED: step 0/)
    assert.equal(journal.at(-1).write, 'journal::finish')
    assert.equal(journal.at(-1).outcome.error.code, 'DIVERGED')
  })

  it('stops a fenced run for good, even when the code catches the error and goes on', async () => {
    const { worker, sent, journal, invoke } = fakeWorker({
      answers: ANSWERS,
      reject: { 'journal::result': { rejected: 'FENCED', message: 'FENCED: workflow wf is at epoch 3' } },
    })
    worker.registerFunction(
      'agent::run',
      async () => {
        await worker.call({ function_id: 'clock::now', payload: {} }).catch(() => undefined)
        return worker.call({ function_id: 'model::complete', payload: {} })
      },
      { metadata: { durable: true } },
    )
    await assert.rejects(invoke('agent::run', { request: 'x' }), /FENCED/)
    assert.deepEqual(sent.map((request) => request.function_id), ['clock::now'])
    assert.ok(!journal.some((entry) => entry.write === 'journal::finish'))
  })

  it('leaves a function without the durable flag alone', async () => {
    const { worker, journal, invoke } = fakeWorker({ answers: ANSWERS })
    worker.registerFunction('agent::run', () => booking(worker), { metadata: { effects: ['writes'] } })
    assert.deepEqual(await invoke('agent::run', { request: 'x' }), { sent: 'msg-1' })
    assert.deepEqual(journal, [])
  })

  it('hashes two inputs that are the same JSON the same, whatever order their keys were written in', () => {
    assert.equal(inputHash({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }), inputHash({ b: { c: [1, { e: 3, d: 2 }] }, a: 1 }))
    assert.notEqual(inputHash({ a: 1 }), inputHash({ a: '1' }))
  })
})

/** Reads the time, waits for approval with a timeout, and sends only when approved. */
async function approvedBooking(worker) {
  const { now } = await worker.call({ function_id: 'clock::now', payload: {} })
  const decision = await worker.call({ function_id: 'durable::wait', payload: { name: 'approval', timeout_ms: 60_000 } })
  if (decision.timed_out || !decision.value.approved) {
    return { sent: null, now }
  }

  const sent = await worker.call({ function_id: 'email::send', payload: { to: 'dana' } })
  return { sent: sent.id, now }
}

describe('waits and sleeps in the preload', () => {
  it('parks the run at a wait with nothing to return: the handler returns pending, sends nothing after it, and never finishes', async () => {
    const { worker, sent, journal, invoke } = fakeWorker({ answers: ANSWERS })
    worker.registerFunction('agent::run', () => approvedBooking(worker), { metadata: { durable: true } })
    assert.deepEqual(await invoke('agent::run', { request: 'x', _workflow_id: 'wf' }), {
      pending: true,
      workflow_id: 'wf',
      waiting_for: { step: 1, function_id: 'durable::wait', kind: 'wait' },
    })
    assert.deepEqual(sent.map((request) => request.function_id), ['clock::now'])
    const parked = journal.find((entry) => entry.write === 'journal::park')
    assert.deepEqual(parked.park, { kind: 'wait', name: 'approval', timeout_ms: 60_000 })
    assert.equal(parked.input_hash, inputHash({ name: 'approval', timeout_ms: 60_000 }))
    assert.ok(!journal.some((entry) => entry.write === 'journal::finish'))
  })

  it('gives the code the value the journal saved for a wait, and goes on to the send', async () => {
    const steps = [
      { step: 0, function_id: 'clock::now', input_hash: inputHash({}), outcome: { ok: true, value: { now: 'today' } } },
      { step: 1, function_id: 'durable::wait', input_hash: inputHash({ name: 'approval', timeout_ms: 60_000 }), outcome: { ok: true, value: { timed_out: false, value: { approved: true } } } },
    ]
    const { worker, sent, journal, invoke } = fakeWorker({ claim: { status: 'running', epoch: 2, steps }, answers: ANSWERS })
    worker.registerFunction('agent::run', () => approvedBooking(worker), { metadata: { durable: true } })
    assert.deepEqual(await invoke('agent::run', { request: 'x', _workflow_id: 'wf' }), { sent: 'msg-1', now: 'today' })
    assert.deepEqual(sent.map((request) => request.function_id), ['email::send'])
    assert.ok(!journal.some((entry) => entry.write === 'journal::park'))
  })

  it('goes on without parking when the journal already has a value for the wait, or the timeout won', async () => {
    const { worker, sent, invoke } = fakeWorker({ answers: ANSWERS, park: () => ({ outcome: { ok: true, value: { timed_out: true } } }) })
    worker.registerFunction('agent::run', () => approvedBooking(worker), { metadata: { durable: true } })
    assert.deepEqual(await invoke('agent::run', { request: 'x' }), { sent: null, now: 'today' })
    assert.deepEqual(sent.map((request) => request.function_id), ['clock::now'])
  })

  it('returns pending without running the code when the run is already waiting', async () => {
    const pending = { step: 1, function_id: 'durable::wait', kind: 'wait', name: 'approval' }
    const { worker, sent, invoke } = fakeWorker({ claim: { status: 'waiting', pending }, answers: ANSWERS })
    worker.registerFunction('agent::run', () => approvedBooking(worker), { metadata: { durable: true } })
    assert.deepEqual(await invoke('agent::run', { request: 'x', _workflow_id: 'wf' }), { pending: true, workflow_id: 'wf', waiting_for: pending })
    assert.deepEqual(sent, [])
  })

  it('parks the run when the journal refuses a call started beside a wait that already parked', async () => {
    const pending = { step: 0, function_id: 'durable::sleep', kind: 'sleep' }
    const { worker, sent, invoke } = fakeWorker({ answers: ANSWERS, reject: { 'journal::intent': { rejected: 'WAITING', message: 'WAITING: wf is waiting at step 0', pending } } })
    worker.registerFunction(
      'agent::run',
      async () => Promise.all([worker.call({ function_id: 'durable::sleep', payload: { ms: 1_000 } }), worker.call({ function_id: 'clock::now', payload: {} })]),
      { metadata: { durable: true } },
    )
    assert.deepEqual(await invoke('agent::run', { request: 'x', _workflow_id: 'wf' }), { pending: true, workflow_id: 'wf', waiting_for: pending })
    assert.deepEqual(sent, [])
  })

  it('fails the run as DIVERGED when a wait comes back with another name', async () => {
    const steps = [{ step: 0, function_id: 'durable::wait', input_hash: inputHash({ name: 'approval' }), outcome: { ok: true, value: { timed_out: false, value: 1 } } }]
    const { worker, journal, invoke } = fakeWorker({ claim: { status: 'running', epoch: 2, steps } })
    worker.registerFunction('agent::run', () => worker.call({ function_id: 'durable::wait', payload: { name: 'sign-off' } }), { metadata: { durable: true } })
    await assert.rejects(invoke('agent::run', { request: 'x' }), /DIVERGED: step 0/)
    assert.equal(journal.at(-1).outcome.error.code, 'DIVERGED')
  })

  it('throws a bad wait or sleep back to the code before it takes a step number', async () => {
    const { worker, journal, invoke } = fakeWorker({ answers: ANSWERS })
    worker.registerFunction(
      'agent::run',
      async () => {
        const errors = []
        for (const request of [
          { function_id: 'durable::wait', payload: {} },
          { function_id: 'durable::wait', payload: { name: 'a', timeout_ms: -1 } },
          { function_id: 'durable::sleep', payload: { ms: 'soon' } },
          { function_id: 'durable::nap', payload: {} },
        ]) {
          await worker.call(request).catch((error) => errors.push(error.code))
        }

        await worker.call({ function_id: 'clock::now', payload: {} })
        return errors
      },
      { metadata: { durable: true } },
    )
    assert.deepEqual(await invoke('agent::run', { request: 'x' }), ['INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'INVALID_ARGUMENT'])
    assert.equal(journal.find((entry) => entry.write === 'journal::intent').step, 0)
  })

  it('fails a wait or sleep made outside a durable run at once, without sending it', async () => {
    const { worker, sent } = fakeWorker()
    await assert.rejects(worker.call({ function_id: 'durable::wait', payload: { name: 'approval' } }), (error) => {
      assert.equal(error.code, 'NOT_DURABLE')
      assert.match(error.message, /durable::wait only works inside a durable run/)
      return true
    })
    await assert.rejects(worker.call({ function_id: 'durable::sleep', payload: { ms: 10 } }), /only works inside a durable run/)
    assert.deepEqual(sent, [])
  })
})
