/**
 * Questions (b) and (c) outside the observer model: the worker manager's middleware hook,
 * which docs/spike.md left as the next thing to probe. It runs a function on every call made
 * by a worker connected through its listener, before the call is dispatched.
 *
 * The app worker connects through the middleware listener (49837). probe::middleware writes a
 * start record, then forwards the call; for some labels it waits first or sends the call to
 * probe::alt. A recorder observes probe::slow the way Rewind does, to see what `caller` says
 * for a forwarded call. Last, the owner is killed in the middle of a forwarded call.
 *
 * Run from this folder after `npm install`: npx tsx q5Middleware.ts
 */
import { brief, connect, finish, log, sleep, startEngine, startRole, waitForFunctions } from './lib.js'

type Forward = { function_id: string; payload: { label?: string; hold_ms?: number }; context?: unknown; [key: string]: unknown }

const engine = await startEngine('q5', 'config-middleware.yaml')
const owner = startRole('owner', 'owner.ts', { ROLE_NAME: 'probe-owner' })
await owner.waitFor(/^ROLE/)

const starts: { at: number; function_id: string; payload: unknown }[] = []
const middleware = connect('probe-middleware')
middleware.registerFunction('probe::auth', async () => ({ allowed_functions: [], context: { session: 'app' } }))
middleware.registerFunction('probe::alt', async (payload: { label?: string }) => ({ handled_by: 'probe::alt', label: payload.label }))
middleware.registerFunction('probe::middleware', async (input: Forward) => {
  const label = input.payload?.label ?? ''
  starts.push({ at: Date.now(), function_id: input.function_id, payload: input.payload })
  const own = middleware.currentInvocation()
  log(`HOOK middleware start ${input.function_id} ${label}: input keys ${Object.keys(input).join(', ')}; its own caller ${JSON.stringify(own?.caller)}`)
  if (label.startsWith('hold')) {
    await sleep(1500)
    log(`HOOK middleware done holding ${label}`)
  }

  const target = label.startsWith('redirect') ? 'probe::alt' : input.function_id
  try {
    const result = await middleware.call({ function_id: target, payload: input.payload, timeoutMs: 120_000 })
    log(`HOOK middleware end ${input.function_id} ${label}`)
    return result
  } catch (error) {
    log(`HOOK middleware saw ${input.function_id} ${label} fail; its start record is ${JSON.stringify(starts.find((start) => (start.payload as { label?: string })?.label === label))}`, brief(error))
    throw error
  }
})

const recorder = connect('probe-recorder-e')
recorder.registerFunction('probe::record-e', async (observed: { input?: { label?: string }; status: string; caller?: unknown }) => {
  log(`EVENT recorder got ${observed.input?.label} (${observed.status}), caller ${JSON.stringify(observed.caller)}`)
  return null
})
await waitForFunctions(recorder, ['probe::slow', 'probe::middleware', 'probe::auth', 'probe::record-e'])
await recorder.observe({ function_id: 'probe::slow', capture: ['input', 'output', 'error', 'caller'] }, 'probe::record-e').ready()

const app = connect('probe-app', 'ws://127.0.0.1:49837')
app.registerFunction('probe::app-run', async (input: { label: string; hold_ms: number }) => {
  return app.call({ function_id: 'probe::slow', payload: { ...input, label: `${input.label}-child` }, timeoutMs: 120_000 })
})
await waitForFunctions(recorder, ['probe::app-run'])

async function appCall(functionId: string, label: string, holdMs = 0): Promise<void> {
  const sent = Date.now()
  log(`CALL ${functionId} ${label}`)
  await app
    .call({ function_id: functionId, payload: { label, hold_ms: holdMs }, timeoutMs: 120_000 })
    .then((value) => log(`CALL ${label} answered after ${Date.now() - sent} ms`, value))
    .catch((error) => log(`CALL ${label} failed after ${Date.now() - sent} ms`, brief(error)))
  await sleep(300)
}

await appCall('probe::slow', 'plain')
await appCall('probe::app-run', 'nested')
await appCall('probe::slow', 'hold')
await appCall('probe::slow', 'redirect')

log('--- the owner is killed in the middle of a forwarded call')
const killed = appCall('probe::slow', 'killed', 60_000)
await owner.waitFor(/HANDLER start killed/)
await sleep(500)
owner.kill('SIGKILL')
await killed
await sleep(1000)
log(`start records the middleware wrote: ${starts.length}`, starts.map((start) => `${start.function_id} ${(start.payload as { label?: string })?.label ?? ''}`))

await finish(engine, [app, recorder, middleware])
