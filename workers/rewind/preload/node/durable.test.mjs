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
function fakeWorker({ claim = { status: 'running', epoch: 1, steps: [] }, answers = {}, reject = {} } = {}) {
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
