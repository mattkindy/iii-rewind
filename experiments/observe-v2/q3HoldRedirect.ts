/**
 * Question (c): can onObservationDeliver, or anything else in 0.26, let a function's owner or
 * a third party hold a call or send it somewhere else?
 *
 * The owner hosts probe::pay, whose handler logs a side effect. Its deliver hook reads `mode`:
 * hold waits 2 s, redirect returns what probe::alt (a third worker's observer target) answers,
 * refuse throws, and pass returns the handler's output. A recorder observes probe::pay the way
 * Rewind does. Then a third party that does not host probe::pay sets its own deliver hook,
 * calls through its observer, and registers probe::pay itself.
 *
 * Run from this folder after `npm install`: npx tsx q3HoldRedirect.ts
 */
import { setTimeout as sleep } from 'node:timers/promises'
import type { Observer } from 'iii-sdk'
import { brief, connect, finish, log, observerRows, startEngine, waitForFunctions } from './lib.js'

type Pay = { mode: 'hold' | 'redirect' | 'refuse' | 'pass'; order: string }

const engine = await startEngine('q3')
const owner = connect('probe-owner-c')
owner.registerFunction('probe::pay', async (input: Pay) => {
  log(`HANDLER side effect: charged order ${input.order}`)
  return { charged: true, order: input.order }
})
owner.onObservationDeliver('probe::pay', async (call, observers: readonly Observer[]) => {
  const input = call.input as Pay
  log(`HOOK deliver for ${input.order} (mode ${input.mode}): handler output ${JSON.stringify(call.output)}, ${observers.length} observers matched`)
  if (input.mode === 'hold') {
    await sleep(2000)
    log(`HOOK deliver for ${input.order}: done holding`)
    return call.output
  }

  if (input.mode === 'redirect') {
    const alt = observers.find((obs) => JSON.stringify(obs.target).includes('probe::alt'))
    if (!alt) {
      return { redirected: false, why: 'no observer targets probe::alt' }
    }

    return owner.call({ observer: alt, payload: call.input })
  }

  if (input.mode === 'refuse') {
    throw new Error(`the deliver hook refused order ${input.order}`)
  }

  return call.output
})

const third = connect('probe-third-party')
third.registerFunction('probe::alt', async (payload: Pay) => {
  log(`EVENT probe::alt got order ${payload.order}`)
  return { charged: false, handled_by: 'probe::alt', order: payload.order }
})

const recorder = connect('probe-recorder-c')
recorder.registerFunction('probe::record-pay', async (observed: Record<string, unknown>) => {
  log('EVENT recorder got', { input: observed.input, output: observed.output, status: observed.status })
  return null
})

await waitForFunctions(recorder, ['probe::pay', 'probe::alt', 'probe::record-pay'])
const recording = recorder.observe({ function_id: 'probe::pay', capture: ['input', 'output', 'error', 'caller'] }, 'probe::record-pay')
const toAlt = third.observe('probe::pay', 'probe::alt')
await Promise.all([recording.ready(), toAlt.ready()])

const caller = connect('probe-caller-c')
for (const mode of ['pass', 'hold', 'redirect', 'refuse'] as const) {
  const sent = Date.now()
  log(`CALL ${mode}`)
  await caller
    .call({ function_id: 'probe::pay', payload: { mode, order: `o-${mode}` }, timeoutMs: 10_000 })
    .then((value) => log(`CALL ${mode} answered after ${Date.now() - sent} ms`, value))
    .catch((error) => log(`CALL ${mode} failed after ${Date.now() - sent} ms`, brief(error)))
  await sleep(300)
}

log('observer rows for probe::pay', await observerRows(recorder, 'probe::pay'))

log('--- a third party that does not host probe::pay')
third.onObservationDeliver('probe::pay', async () => {
  log('HOOK the third party deliver hook ran')
  return { stolen: true }
})
await caller
  .call({ function_id: 'probe::pay', payload: { mode: 'pass', order: 'o-third' }, timeoutMs: 10_000 })
  .then((value) => log('CALL after the third party set a deliver hook answered', value))
  .catch((error) => log('CALL after the third party set a deliver hook failed', brief(error)))

await third
  .call({ observer: { id: toAlt.id, target: 'probe::alt' } as unknown as Observer, payload: { mode: 'pass', order: 'o-through' } })
  .then((value) => log('third party call through its own observer answered', value))
  .catch((error) => log('third party call through its own observer failed', brief(error)))

const rival = connect('probe-rival')
rival.registerFunction('probe::pay', async () => ({ charged: false, handled_by: 'rival' }))
await sleep(1000)
await caller
  .call({ function_id: 'probe::pay', payload: { mode: 'pass', order: 'o-rival' }, timeoutMs: 10_000 })
  .then((value) => log('CALL after a rival registered probe::pay answered', value))
  .catch((error) => log('CALL after a rival registered probe::pay failed', brief(error)))

await finish(engine, [caller, rival, third, recorder, owner])
