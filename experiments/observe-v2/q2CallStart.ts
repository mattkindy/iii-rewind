/**
 * Question (b): can an observer fire when a call starts, or see a call before its worker runs it?
 *
 * The owner hosts probe::step, whose handler waits 1500 ms, and sets an onObservationMatch
 * hook that logs when it runs and what the call has in it. Three observers in another worker
 * watch it with different captures. A caller in a third worker calls probe::step, and the
 * timeline shows when the handler started, when the match hook ran, when each target ran and
 * when the caller got its answer. Then the same call is made from the owner itself, which runs
 * in-process. Last, the probe tries to ask for a call-start event: a 0.25 `on` value, a capture
 * with no outcome in it, and the list of event sources the engine hosts.
 *
 * Run from this folder after `npm install`: npx tsx q2CallStart.ts
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { brief, connect, finish, log, startEngine, waitForFunctions } from './lib.js'

const engine = await startEngine('q2')
const owner = connect('probe-owner-b')
owner.registerFunction('probe::step', async (input: { hold_ms: number; label: string }) => {
  log(`HANDLER start ${input.label}`)
  await sleep(input.hold_ms)
  log(`HANDLER end ${input.label}`)
  return { done: input.label }
})
owner.onObservationMatch('probe::step', (obs, call) => {
  const fields = Object.keys(call).filter((key) => (call as Record<string, unknown>)[key] !== undefined)
  log(`HOOK match for observer ${obs.id.slice(0, 8)} on ${(call.input as { label: string }).label}: call has ${fields.join(', ')}; status ${call.status}`)
  return true
})

const recorder = connect('probe-recorder-b')
for (const name of ['default', 'input', 'input-error']) {
  recorder.registerFunction(`probe::seen-${name}`, async (observed: Record<string, unknown>) => {
    log(`EVENT ${name}: status ${observed.status}, started_at_ms ${observed.started_at_ms}, duration_ms ${Math.round(Number(observed.duration_ms))}, fields ${Object.keys(observed).join(', ')}`)
    return null
  })
}

await waitForFunctions(recorder, ['probe::step', 'probe::seen-default'])
const handles = [
  recorder.observe('probe::step', 'probe::seen-default'),
  recorder.observe({ function_id: 'probe::step', capture: ['input'] }, 'probe::seen-input'),
  recorder.observe({ function_id: 'probe::step', capture: ['input', 'error'] }, 'probe::seen-input-error'),
]
await Promise.all(handles.map((handle) => handle.ready()))

const caller = connect('probe-caller-b')
log('CALL sent, routed through the engine')
const answer = await caller.call({ function_id: 'probe::step', payload: { hold_ms: 1500, label: 'routed' } })
log('CALL answered', answer)
await sleep(500)

log('CALL sent from the owner itself, in-process')
log('CALL answered', await owner.call({ function_id: 'probe::step', payload: { hold_ms: 1500, label: 'local' } }))
await sleep(1500)

// A 0.25 SDK could send `on`; the 0.26 SDK has no field for it, so this goes through as an unknown key.
const legacyStart = recorder.observe({ function_id: 'probe::step', on: 'start' } as never, 'probe::seen-default')
await legacyStart
  .ready()
  .then(() => log(`observe with on: "start" went ${legacyStart.state}`))
  .catch((error) => log('observe with on: "start" refused', brief(error)))
const callerOnly = recorder.observe({ function_id: 'probe::step', capture: ['caller'] }, 'probe::seen-default')
await callerOnly
  .ready()
  .then(() => log(`observe with capture ["caller"] went ${callerOnly.state}`))
  .catch((error) => log('observe with capture ["caller"] refused', brief(error)))
if (legacyStart.state === 'active') {
  log('CALL sent with the on: "start" observer active')
  await caller.call({ function_id: 'probe::step', payload: { hold_ms: 1000, label: 'with-on-start' } })
  await sleep(500)
  await legacyStart.dispose()
}

const listed = await recorder.call<unknown, { functions: { function_id: string }[] }>({
  function_id: 'engine::functions::list',
  payload: { include_internal: true },
})
log(
  'engine-hosted event sources',
  listed.functions.map((row) => row.function_id).filter((id) => /^engine::on-|::on-/.test(id)),
)

await finish(engine, [caller, recorder, owner])
