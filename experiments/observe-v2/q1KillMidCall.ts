/**
 * Question (a): when the worker running a call is killed mid-call, does any observer get an
 * event for the interrupted call? docs/spike.md found none on 0.25.
 *
 * The owner process hosts probe::slow. Three observers watch it: Rewind's own capture
 * (input, output, error, caller), a failures-only observer (capture input and error, filtered
 * on error existing), and an observer of probe::parent, which calls probe::slow from its
 * handler in another worker. engine::on-observers-changed and engine::on-workers-changed are
 * observed too, to see the order of what the engine does. The owner is SIGKILLed 600 ms into
 * a 60 s call.
 *
 * Run from this folder after `npm install`: npx tsx q1KillMidCall.ts
 * OWNER_SDK=0.25 runs the owner on the 0.25 SDK instead.
 */
import { brief, connect, finish, log, observerRows, sleep, startEngine, startRole, waitForFunctions } from './lib.js'

const engine = await startEngine('q1')
const owner = startRole('owner', 'owner.ts', { ROLE_NAME: 'probe-owner', OWNER_SDK: process.env.OWNER_SDK ?? '0.26' })
await owner.waitFor(/^ROLE/)
log(`the owner runs on SDK ${process.env.OWNER_SDK ?? '0.26'}`)

const recorder = connect('probe-recorder')
const events: { observer: string; envelope: Record<string, unknown> }[] = []
for (const name of ['complete', 'failures', 'parent', 'observers-changed', 'workers-changed']) {
  recorder.registerFunction(`probe::record-${name}`, async (envelope: Record<string, unknown>) => {
    events.push({ observer: name, envelope })
    if (name.endsWith('-changed')) {
      log(`EVENT ${name}`, envelope.input)
    } else {
      log(`EVENT ${name}`, { function_id: envelope.function_id, status: envelope.status, input: envelope.input, error: brief(envelope.error) })
    }

    return null
  })
}

const parent = connect('probe-parent')
parent.registerFunction('probe::parent', async (input: { hold_ms: number; label: string }) => {
  return parent.call({ function_id: 'probe::slow', payload: input, timeoutMs: 120_000 })
})

await waitForFunctions(recorder, ['probe::slow', 'probe::parent', 'probe::record-complete'])
const handles = [
  recorder.observe({ function_id: 'probe::slow', capture: ['input', 'output', 'error', 'caller'] }, 'probe::record-complete'),
  recorder.observe(
    { function_id: 'probe::slow', capture: ['input', 'error'], filters: { error: { $exists: true } } },
    'probe::record-failures',
  ),
  recorder.observe({ function_id: 'probe::parent', capture: ['input', 'output', 'error', 'caller'] }, 'probe::record-parent'),
  recorder.observe({ function_id: 'engine::on-observers-changed', capture: ['input'] }, 'probe::record-observers-changed'),
  recorder.observe({ function_id: 'engine::on-workers-changed', capture: ['input'] }, 'probe::record-workers-changed'),
]
await Promise.all(handles.map((handle) => handle.ready()))
log('observers active', handles.map((handle) => handle.id.slice(0, 8)))

const caller = connect('probe-caller')
log('control call', await caller.call({ function_id: 'probe::slow', payload: { hold_ms: 0, label: 'control' } }))
await sleep(500)
events.length = 0

const direct = caller
  .call({ function_id: 'probe::slow', payload: { hold_ms: 60_000, label: 'direct' }, timeoutMs: 120_000 })
  .then((value) => log('direct call RESULT', value))
  .catch((error) => log('direct call ERROR', { code: error.code, message: error.message }))
const viaParent = caller
  .call({ function_id: 'probe::parent', payload: { hold_ms: 60_000, label: 'via-parent' }, timeoutMs: 120_000 })
  .then((value) => log('parent call RESULT', value))
  .catch((error) => log('parent call ERROR', { code: error.code, message: error.message }))

await owner.waitFor(/HANDLER start via-parent/)
await owner.waitFor(/HANDLER start direct/)
await sleep(600)
owner.kill('SIGKILL')
await Promise.all([direct, viaParent])
await sleep(10_000)

const ofSlow = events.filter((event) => event.envelope.function_id === 'probe::slow')
log(`events for probe::slow in the 10 s after the kill: ${ofSlow.length}`)
log(`events for probe::parent: ${events.filter((event) => event.observer === 'parent').length}`)
log('observer rows for probe::slow', await observerRows(recorder, 'probe::slow'))
log('observer rows for probe::parent', await observerRows(recorder, 'probe::parent'))

await finish(engine, [caller, parent, recorder])
